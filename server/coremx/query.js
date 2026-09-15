'use strict';
const lower = (s) =>
    String(s || '')
        .normalize('NFKC')
        .toLowerCase();
// Bounded KQL expression parser: implicit AND, explicit AND/OR/NOT, grouping,
// quoted phrases, prefix wildcards, and mail property restrictions.
module.exports = function compile(query) {
    if (typeof query !== 'string' || query.length > 2048) throw new Error('Query too large');
    const tokens = query.match(/"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+/g) || [];
    let position = 0;
    if (tokens.length > 150) throw new Error('Query too complex');
    const unquote = (s) => (s?.startsWith('"') ? s.slice(1, -1).replace(/\\(["\\])/g, '$1') : s);
    const matchText = (text, term) => {
        text = lower(text);
        term = lower(unquote(term));
        if (term.includes('*')) {
            if (!term.endsWith('*') || term.slice(0, -1).includes('*'))
                throw new Error('Only prefix wildcards are supported');
            term = term.slice(0, -1);
            return text.split(/[^\p{L}\p{N}@._+-]+/u).some((word) => word.startsWith(term));
        }
        return text.includes(term);
    };
    function property(key, term) {
        key = lower(key);
        term = unquote(term);
        if (!term) throw new Error('Missing property value');
        if (
            ![
                '',
                'from',
                'to',
                'cc',
                'bcc',
                'participants',
                'recipients',
                'subject',
                'body',
                'attachment',
                'hasattachment',
                'hasattachments',
                'has',
                'is',
                'read',
                'starred',
                'after',
                'before',
                'sent',
                'received',
                'date',
                'size',
                'importance',
                'kind',
                'in',
                'category',
                'categories'
            ].includes(key)
        )
            throw new Error('Unsupported search property');
        return async (item, get, folder) => {
            if (key === 'kind') return lower(term) === 'email';
            if (['hasattachment', 'hasattachments', 'has'].includes(key)) {
                const parsed = await get();
                return ['true', '1', 'attachment'].includes(lower(term))
                    ? parsed.attachments.length > 0
                    : ['false', '0'].includes(lower(term))
                      ? parsed.attachments.length === 0
                      : false;
            }
            if (key === 'is')
                return term === 'read'
                    ? !!item.read
                    : term === 'unread'
                      ? !item.read
                      : term === 'starred'
                        ? !!item.starred
                        : false;
            if (key === 'read' || key === 'starred')
                return !!item[key] === ['true', '1'].includes(lower(term));
            if (key === 'in') return matchText(folder?.name, term);
            if (key === 'category' || key === 'categories')
                return (item.labels || []).some((label) => matchText(label, term));
            if (['after', 'before', 'sent', 'received', 'date', 'size'].includes(key)) {
                const raw = key === 'size' ? item.size : Date.parse(item.date);
                const parse = (v) => (key === 'size' ? Number(v) : Date.parse(v));
                if (term.includes('..')) {
                    const [from, to, ...extra] = term.split('..');
                    if (extra.length) throw new Error('Invalid range');
                    const min = parse(from),
                        max = parse(to);
                    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('Invalid range');
                    return raw >= min && raw <= (key === 'size' ? max : max + 86399999);
                }
                const parts = /^(>=|<=|>|<|=)?(.+)$/.exec(term),
                    v = parse(parts[2]);
                if (!Number.isFinite(v)) throw new Error('Invalid comparison');
                const op = parts[1] || (key === 'after' ? '>=' : key === 'before' ? '<' : '=');
                return op === '>'
                    ? raw > v
                    : op === '>='
                      ? raw >= v
                      : op === '<'
                        ? raw < v
                        : op === '<='
                          ? raw <= v
                          : key === 'size'
                            ? raw === v
                            : raw >= v && raw < v + 86400000;
            }
            const parsed = await get();
            if (key === 'importance') return lower(parsed.priority || 'normal') === lower(term);
            if (key === 'attachment') return parsed.attachments.some((a) => matchText(a.filename, term));
            if (key === 'participants' || key === 'recipients')
                return [
                    parsed.to?.text,
                    parsed.cc?.text,
                    parsed.bcc?.text,
                    ...(key === 'participants' ? [parsed.from?.text] : [])
                ].some((v) => matchText(v, term));
            const text =
                key === 'body'
                    ? parsed.text
                    : key === 'subject'
                      ? parsed.subject
                      : ['from', 'to', 'cc', 'bcc'].includes(key)
                        ? parsed[key]?.text
                        : [
                              parsed.subject,
                              parsed.from?.text,
                              parsed.to?.text,
                              parsed.cc?.text,
                              parsed.text
                          ].join('\n');
            return matchText(text, term);
        };
    }
    function atom(depth) {
        if (depth > 12) throw new Error('Query depth');
        const token = tokens[position++];
        if (!token) throw new Error('Missing expression');
        if (token === 'NOT' || token.startsWith('-')) {
            const test = token === 'NOT' ? atom(depth + 1) : property('', token.slice(1));
            return async (...args) => !(await test(...args));
        }
        if (token === '(') {
            const test = or(depth + 1);
            if (tokens[position++] !== ')') throw new Error('Unclosed group');
            return test;
        }
        if (['AND', 'OR', ')'].includes(token)) throw new Error('Unexpected operator');
        const index = token.indexOf(':');
        if (index > 0 && !token.startsWith('"')) {
            let term = token.slice(index + 1);
            if (!term) term = tokens[position++];
            if (!term || ['(', ')', 'AND', 'OR'].includes(term)) throw new Error('Property value required');
            return property(token.slice(0, index), term);
        }
        return property('', token);
    }
    function and(depth) {
        const tests = [atom(depth)];
        while (position < tokens.length && tokens[position] !== ')' && tokens[position] !== 'OR') {
            if (tokens[position] === 'AND') position++;
            tests.push(atom(depth));
        }
        return async (...args) => {
            for (const test of tests) if (!(await test(...args))) return false;
            return true;
        };
    }
    function or(depth) {
        const tests = [and(depth)];
        while (tokens[position] === 'OR') {
            position++;
            tests.push(and(depth));
        }
        return async (...args) => {
            for (const test of tests) if (await test(...args)) return true;
            return false;
        };
    }
    if (!tokens.length) return () => true;
    const result = or(0);
    if (position !== tokens.length) throw new Error('Unexpected query text');
    return result;
};
