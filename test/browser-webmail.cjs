'use strict';
// Source-level browser integration: actual Vue page and actual encrypted MailStore APIs.
// Playwright fulfills assets in memory; this test starts no Node TCP listener.
const fs = require('node:fs/promises'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const { chromium } = require('../.cache/browser/node_modules/playwright');
const { parse, compileTemplate } = require('../composite_portal/node_modules/@vue/compiler-sfc');
const fixture = require('./helpers/mail');
const { Webmail } = require('../server/coremx/webmail');
const { compose } = require('../server/coremx/mime');
(async () => {
    const cleanup = [];
    const x = await fixture({ after: (fn) => cleanup.push(fn) });
    let browser;
    try {
        const web = new Webmail(x.mail, { ...x.auth, device: { id: 'web:alice' } });
        const messages = [
            [
                'Maya Chen <maya@example.test>',
                'A few ideas for the autumn launch',
                'Hi Alice,\n\nI’ve pulled together our thoughts for the autumn launch. The direction is looking good, and I’d love your take before we share it with the team.\n\nThe brief is attached. Let’s catch up on Thursday?\n\nThanks,\nMaya'
            ],
            [
                'Oliver Grant <oliver@example.test>',
                'Thursday’s design review',
                'The updated prototype is ready for a look.'
            ],
            [
                'Studio North <hello@example.test>',
                'Your weekly inspiration',
                'A collection of thoughtful work from around the studio.'
            ],
            [
                'Sophie Wilson <sophie@example.test>',
                'Re: A simpler onboarding experience',
                'These changes feel much clearer. Let’s take them forward.'
            ],
            [
                'Alex Morgan <alex@example.test>',
                'September project notes',
                'A quick update on where things stand this week.'
            ],
            ['Maya Chen <maya@example.test>', 'Coffee next week?', 'It would be lovely to catch up.']
        ];
        for (let i = 0; i < messages.length; i++) {
            const [from, subject, text] = messages[i];
            const bytes = await compose({
                from,
                to: x.box.email,
                subject,
                text,
                date: new Date(Date.now() - i * 3600000),
                attachments:
                    i === 0
                        ? [
                              {
                                  filename: 'Autumn launch brief.txt',
                                  content: Buffer.from('Review the autumn launch brief.')
                              }
                          ]
                        : []
            });
            await x.mail.deliver({ recipient: x.box.email, bytes, deliveryId: 'browser-' + i });
        }
        await web.contacts({
            action: 'save',
            firstName: 'Maya',
            lastName: 'Chen',
            email: 'maya@example.test',
            company: 'Studio North'
        });
        const pageSource = await fs.readFile(path.resolve('portal/pages/mail/index.vue'), 'utf8');
        const { descriptor } = parse(pageSource);
        const template = compileTemplate({
            source: descriptor.template.content,
            filename: 'webmail.vue',
            id: 'mx-browser',
            compilerOptions: { mode: 'function' }
        });
        if (template.errors.length) throw template.errors[0];
        const css = await fs.readFile('portal/assets/coremx-webmail.css', 'utf8');
        const vue = await fs.readFile('composite_portal/node_modules/vue/dist/vue.global.prod.js', 'utf8');
        const mdi = await fs.readFile(
            'composite_portal/node_modules/@mdi/font/css/materialdesignicons.min.css',
            'utf8'
        );
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await page.emulateMedia({ colorScheme: 'light' });
        const failures = [];
        page.on('pageerror', (e) => failures.push(e.message));
        await page.exposeBinding('coremxApi', async (_, request) => {
            try {
                return {
                    status: 100,
                    payload:
                        request.handle === 'list'
                            ? { ownedMailboxes: [x.box], admin: true }
                            : await web.handle(request.handle.replace(/^mail\./, ''), request.data)
                };
            } catch (e) {
                return { status: 400, payload: { msg: e.message } };
            }
        });
        await page.route('https://coremx.test/**', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.includes('materialdesignicons-webfont'))
                return route.fulfill({
                    body: await fs.readFile(
                        'composite_portal/node_modules/@mdi/font/fonts/' + path.basename(url.pathname)
                    ),
                    contentType: 'font/woff2'
                });
            const script = descriptor.script.content.replace('export default', 'const pageComponent =');
            return route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}button,input,select,textarea{border:0;background:none}button{padding:0}h1,h2,h3,p{margin:0}.v-icon{font-style:normal;display:inline-flex;align-items:center;justify-content:center;line-height:1}.mdi{font-family:'Material Design Icons'}.mdi::before{font-size:inherit}${mdi}${css}</style></head><body><div id="app"></div><script>${vue}</script><script>${script}\npageComponent.render=(new Function('Vue',${JSON.stringify(template.code)}))(Vue);const app=Vue.createApp(pageComponent);app.component('v-icon',{props:['size'],render(){const name=this.$slots.default?.()[0]?.children || '';return Vue.h('i',{class:'v-icon mdi '+name,style:{fontSize:(this.size || 24)+'px'},'aria-hidden':'true'});}});app.component('NuxtLink',{props:['to'],render(){return Vue.h('a',{href:this.to},this.$slots.default?.());}});app.config.globalProperties.$dcsajax=window.coremxApi;app.mount('#app');</script></body></html>`
            });
        });
        await page.goto('https://coremx.test/mail');
        await page.getByText('A few ideas for the autumn launch', { exact: true }).waitFor();
        await page.getByText('A few ideas for the autumn launch', { exact: true }).click();
        await page.getByText('Autumn launch brief.txt', { exact: true }).waitFor();
        await fs.mkdir('.cache/screenshots', { recursive: true });
        await page.screenshot({
            animations: 'disabled',
            path: '.cache/screenshots/webmail-desktop.png',
            fullPage: true
        });
        await page.screenshot({
            animations: 'disabled',
            path: '.cache/screenshots/webmail-light-desktop.png',
            fullPage: true
        });
        await page.getByRole('button', { name: 'Use dark appearance', exact: true }).click();
        await page.locator('.mx-app[data-theme="dark"]').waitFor();
        await page.screenshot({
            animations: 'disabled',
            path: '.cache/screenshots/webmail-dark-desktop.png',
            fullPage: true
        });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByLabel('Appearance', { exact: true }).selectOption('system');
        await page.locator('.mx-app[data-theme="light"]').waitFor();
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.locator('.mx-app[data-theme="dark"]').waitFor();
        await page.getByLabel('Appearance', { exact: true }).selectOption('light');
        await page.locator('.mx-app[data-theme="light"]').waitFor();
        await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
        await page.emulateMedia({ colorScheme: 'light' });
        await page.locator('.mx-app[data-theme="dark"]').waitFor();
        await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
        await page.getByText('Preferences saved', { exact: true }).waitFor();
        assert.equal((await web.overview()).preferences.appearance, 'dark');
        await page.reload();
        await page.getByText('A few ideas for the autumn launch', { exact: true }).click();
        await page.getByText('Autumn launch brief.txt', { exact: true }).waitFor();
        await page.locator('.mx-app[data-theme="dark"]').waitFor();
        await page.getByRole('button', { name: 'Reply', exact: true }).click();
        await page.getByLabel('Message body', { exact: true }).fill('Thanks Maya, Thursday works well.');
        await page.getByLabel('To', { exact: true }).fill('maya@example.test');
        await page.getByLabel('Subject', { exact: true }).fill('Re: Autumn launch');
        await page.waitForTimeout(1700);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await page.getByText('Message queued for delivery', { exact: true }).waitFor();
        assert.equal(x.scope.list('outbox').length, 1);
        await page.getByRole('button', { name: 'Compose', exact: true }).click();
        await page.getByLabel('To', { exact: true }).fill('oliver@example.test');
        await page.getByLabel('Subject', { exact: true }).fill('Browser saved draft');
        await page.getByLabel('Message body', { exact: true }).fill('Draft saved through the real API.');
        await page.getByRole('button', { name: 'Save and close composer' }).click();
        await page.getByRole('dialog', { name: 'Compose message' }).waitFor({ state: 'hidden' });
        assert.ok(x.scope.list('messages', (m) => m.draft).length);
        await page.getByRole('button', { name: 'Contacts', exact: true }).click();
        await page.getByText('Maya Chen', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'New contact', exact: true }).click();
        await page.getByLabel('First name', { exact: true }).fill('Taylor');
        await page.getByLabel('Email', { exact: true }).fill('taylor@example.test');
        await page.getByRole('button', { name: 'Save contact', exact: true }).click();
        await page.getByRole('button', { name: 'Save contact', exact: true }).waitFor({ state: 'hidden' });
        assert.equal((await web.contacts({})).items.length, 2);
        await page.getByRole('button', { name: 'Calendar', exact: true }).click();
        await page.getByRole('button', { name: 'New event', exact: true }).click();
        await page.getByLabel('Event title', { exact: true }).fill('Browser planning session');
        await page.getByRole('button', { name: 'Save event', exact: true }).click();
        await page.getByText('Event saved', { exact: true }).waitFor();
        assert.equal(x.scope.list('messages', (m) => !!m.calendar).length, 1);
        await page.screenshot({ animations: 'disabled', path: '.cache/screenshots/calendar-desktop.png' });
        await page.screenshot({
            animations: 'disabled',
            path: '.cache/screenshots/calendar-dark-desktop.png'
        });
        await page.getByRole('button', { name: /^Mail/ }).first().click();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: 'Back to messages', exact: true }).click();
        await page.screenshot({ animations: 'disabled', path: '.cache/screenshots/webmail-mobile.png' });
        await page.screenshot({ animations: 'disabled', path: '.cache/screenshots/webmail-dark-mobile.png' });
        await page.getByRole('button', { name: 'Use light appearance', exact: true }).click();
        await page.locator('.mx-app[data-theme="light"]').waitFor();
        await page.screenshot({
            animations: 'disabled',
            path: '.cache/screenshots/webmail-light-mobile.png'
        });
        await page.getByRole('button', { name: 'Use dark appearance', exact: true }).click();
        await page.locator('.mx-app[data-theme="dark"]').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.getByText('A few ideas for the autumn launch', { exact: true }).click();
        await page.getByRole('button', { name: 'Reply', exact: true }).click();
        await page.screenshot({ animations: 'disabled', path: '.cache/screenshots/composer-mobile.png' });
        await page.screenshot({
            animations: 'disabled',
            path: '.cache/screenshots/composer-dark-mobile.png'
        });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.getByRole('button', { name: 'Save and close composer' }).click();
        await page.getByRole('dialog', { name: 'Compose message' }).waitFor({ state: 'hidden' });
        await x.mail.deliver({
            recipient: x.box.email,
            deliveryId: 'html-theme',
            bytes: await compose({
                from: 'studio@example.test',
                to: x.box.email,
                subject: 'HTML colour check',
                text: 'Readable message',
                html: '<table style="background-color:#ffffff"><tr><td><p style="color:#000000">Readable message</p></td></tr></table>'
            })
        });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.getByText('HTML colour check', { exact: true }).click();
        const htmlBody = page.frameLocator('iframe[title="Email content"]').locator('body');
        await htmlBody.getByText('Readable message', { exact: true }).waitFor();
        assert.equal(
            await htmlBody.locator('p').evaluate((el) => getComputedStyle(el).color),
            'rgb(209, 196, 224)'
        );
        await page.getByRole('button', { name: 'Show original colours', exact: true }).click();
        await page.waitForFunction(() =>
            document.querySelector('iframe').srcdoc.includes('body{background:#ffffff')
        );
        await htmlBody.getByText('Readable message', { exact: true }).waitFor();
        assert.equal(
            await htmlBody.locator('p').evaluate((el) => getComputedStyle(el).color),
            'rgb(0, 0, 0)'
        );
        assert.equal(
            await page.locator('iframe').getAttribute('sandbox'),
            'allow-popups allow-popups-to-escape-sandbox'
        );
        assert.deepEqual(failures, []);
        console.log(
            'Browser checks passed: desktop reading, reply/send, draft save, contacts, calendar creation, mobile layout, light/dark appearance, system changes and saved appearance after reload.'
        );
    } finally {
        await browser?.close();
        for (const fn of cleanup) await fn();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
