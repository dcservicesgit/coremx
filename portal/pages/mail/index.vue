<template>
  <div
    class="mx-app"
    :data-theme="resolvedAppearance"
    :class="{
      'mx-compact': preferences.density === 'compact',
      'mx-show-reader': !!message,
      'mx-nav-open': mobileNav
    }"
  >
    <aside class="mx-sidebar">
      <NuxtLink class="mx-brand" to="/mail"
        ><span class="mx-brand-mark"><v-icon size="21">mdi-email-fast-outline</v-icon></span
        >Core<span>MX</span></NuxtLink
      >
      <button class="mx-compose-button" @click="newMessage">
        <v-icon size="21">mdi-pencil-outline</v-icon> Compose
      </button>
      <div class="mx-section-label">WORKSPACE</div>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="mx-nav-item"
        :class="{ active: view === tab.id }"
        @click="switchView(tab.id)"
      >
        <v-icon size="20">{{ tab.icon }}</v-icon
        >{{ tab.label
        }}<span v-if="tab.id === 'mail'" class="mx-count">{{ inboxUnread || '' }}</span>
      </button>
      <template v-if="view === 'mail'">
        <div class="mx-section-label mx-folders-title">
          YOUR MAIL
          <button title="New folder" aria-label="New folder" @click="folderDialog = { name: '' }">
            <v-icon size="17">mdi-plus</v-icon>
          </button>
        </div>
        <button class="mx-folder" :class="{ selected: starred }" @click="chooseFolder('', true)">
          <v-icon size="19">mdi-star-outline</v-icon>Starred
        </button>
        <button
          v-for="folder in mailFolders"
          :key="folder.id"
          class="mx-folder"
          :class="{ selected: folderId === folder.id && !starred }"
          @click="chooseFolder(folder.id)"
        >
          <v-icon size="19">{{ folderIcon(folder) }}</v-icon
          ><span>{{ folderLabel(folder) }}</span
          ><span v-if="folder.unread" class="mx-count">{{ folder.unread }}</span
          ><button
            v-if="folder.type >= 12"
            class="mx-folder-edit"
            :aria-label="'Edit ' + folder.name"
            @click.stop="folderDialog = { ...folder }"
          >
            <v-icon size="16">mdi-dots-horizontal</v-icon>
          </button>
        </button>
      </template>
      <div class="mx-sidebar-bottom">
        <div class="mx-storage">
          <span
            >{{ size(overview.mailbox?.usedBytes || 0) }} of
            {{ size(overview.mailbox?.quotaBytes || 0) }}</span
          >
          <div>
            <i
              :style="{
                width:
                  Math.min(
                    100,
                    ((overview.mailbox?.usedBytes || 0) / (overview.mailbox?.quotaBytes || 1)) * 100
                  ) + '%'
              }"
            />
          </div>
        </div>
        <button class="mx-nav-item" @click="settingsOpen = true">
          <v-icon size="20">mdi-cog-outline</v-icon>Settings</button
        ><NuxtLink v-if="admin" class="mx-nav-item" to="/coremx"
          ><v-icon size="20">mdi-shield-outline</v-icon>Administration</NuxtLink
        ><NuxtLink class="mx-nav-item" to="/admin/auth/passkeysetup"
          ><v-icon size="20">mdi-key-outline</v-icon>Passkeys &amp; security</NuxtLink
        >
        <div class="mx-account">
          <span class="mx-avatar">{{ initials(mailboxEmail) }}</span
          ><select v-model="mailboxId" aria-label="Current mailbox" @change="changeMailbox">
            <option v-for="box in boxes" :key="box.id" :value="box.id">
              {{ box.email }}
            </option></select
          ><NuxtLink to="/admin/auth/logout" title="Sign out" aria-label="Sign out"
            ><v-icon size="18">mdi-logout</v-icon></NuxtLink
          >
        </div>
      </div>
    </aside>
    <main class="mx-main">
      <header class="mx-topbar">
        <button
          class="mx-mobile-menu mx-icon-button"
          aria-label="Toggle navigation"
          @click="mobileNav = !mobileNav"
        >
          <v-icon>mdi-menu</v-icon>
        </button>
        <form class="mx-search" @submit.prevent="searchMail">
          <v-icon size="20">mdi-magnify</v-icon
          ><input v-model="query" aria-label="Search mail" placeholder="Search your mail" /><kbd
            >/</kbd
          ><button
            v-if="query"
            class="mx-icon-button"
            type="button"
            aria-label="Clear search"
            @click="
              query = '';
              searchMail();
            "
          >
            <v-icon size="18">mdi-close</v-icon>
          </button>
        </form>
        <span class="mx-secure"
          ><v-icon size="16">mdi-shield-check-outline</v-icon> Your private workspace</span
        ><button
          class="mx-icon-button"
          :aria-label="
            resolvedAppearance === 'dark' ? 'Use light appearance' : 'Use dark appearance'
          "
          @click="toggleAppearance"
        >
          <v-icon size="20">{{
            resolvedAppearance === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'
          }}</v-icon></button
        ><button class="mx-icon-button" :disabled="loading" aria-label="Refresh" @click="refresh">
          <v-icon size="21">mdi-refresh</v-icon>
        </button>
      </header>
      <div v-if="error" class="mx-error" role="alert">
        <v-icon size="20">mdi-alert-circle-outline</v-icon>{{ error
        }}<button aria-label="Dismiss error" @click="error = ''">×</button>
      </div>
      <div v-if="notice" class="mx-toast" role="status">{{ notice }}</div>
      <div v-if="!boxes.length && !loading" class="mx-empty mx-welcome">
        <span class="mx-empty-icon"><v-icon size="40">mdi-email-outline</v-icon></span>
        <h1>Your workspace is ready.</h1>
        <p>A mailbox needs to be assigned to your account.</p>
        <NuxtLink class="mx-primary" to="/coremx">Manage mailboxes</NuxtLink>
      </div>
      <template v-else-if="view === 'mail'">
        <div class="mx-mail-heading">
          <div>
            <span class="mx-eyebrow">MAIL</span>
            <h1>
              {{
                searchActive ? 'Search results' : starred ? 'Starred' : folderLabel(currentFolder)
              }}
            </h1>
            <p>
              {{ total }} {{ total === 1 ? 'message' : 'messages'
              }}<span v-if="currentFolder?.unread && !searchActive">
                · {{ currentFolder.unread }} unread</span
              >
            </p>
          </div>
          <div class="mx-segment">
            <button
              :class="{ active: !unreadOnly }"
              @click="
                unreadOnly = false;
                loadMessages();
              "
            >
              All mail</button
            ><button
              :class="{ active: unreadOnly }"
              @click="
                unreadOnly = true;
                loadMessages();
              "
            >
              Unread
            </button>
          </div>
        </div>
        <div class="mx-mail-workspace">
          <section class="mx-message-list" aria-label="Messages">
            <div class="mx-list-toolbar">
              <input
                type="checkbox"
                :checked="items.length > 0 && selected.length === items.length"
                aria-label="Select page"
                @change="selected = $event.target.checked ? items.map((m) => m.id) : []"
              /><template v-if="selected.length"
                ><span>{{ selected.length }} selected</span
                ><button
                  class="mx-icon-button"
                  title="Mark read"
                  aria-label="Mark selected as read"
                  @click="bulk('read', true)"
                >
                  <v-icon size="19">mdi-email-open-outline</v-icon></button
                ><button
                  class="mx-icon-button"
                  title="Move to trash"
                  aria-label="Move selected to trash"
                  @click="bulk('trash')"
                >
                  <v-icon size="19">mdi-trash-can-outline</v-icon></button
                ><select
                  aria-label="Move selected messages"
                  @change="
                    bulk('move', null, $event.target.value);
                    $event.target.value = '';
                  "
                >
                  <option value="">Move to…</option>
                  <option v-for="f in destinations" :key="f.id" :value="f.id">
                    {{ folderLabel(f) }}
                  </option>
                </select></template
              ><template v-else
                ><span>{{ loading ? 'Updating…' : 'Newest first' }}</span>
                <div class="mx-pagination">
                  <button
                    class="mx-icon-button"
                    :disabled="offset === 0"
                    aria-label="Previous page"
                    @click="
                      offset -= 50;
                      loadMessages(false);
                    "
                  >
                    <v-icon size="19">mdi-chevron-left</v-icon></button
                  ><span>{{ total ? offset + 1 : 0 }}–{{ Math.min(offset + 50, total) }}</span
                  ><button
                    class="mx-icon-button"
                    :disabled="offset + 50 >= total"
                    aria-label="Next page"
                    @click="
                      offset += 50;
                      loadMessages(false);
                    "
                  >
                    <v-icon size="19">mdi-chevron-right</v-icon>
                  </button>
                </div></template
              >
            </div>
            <div class="mx-list-scroll">
              <div v-if="loading && !items.length" class="mx-loading">
                <div v-for="i in 6" :key="i" class="mx-skeleton" />
              </div>
              <div v-else-if="!items.length" class="mx-empty">
                <v-icon size="38">{{
                  searchActive ? 'mdi-magnify' : 'mdi-check-circle-outline'
                }}</v-icon>
                <h2>{{ searchActive ? 'No matching mail' : 'All clear here' }}</h2>
                <p>
                  {{
                    searchActive
                      ? 'Try a name, subject, or from:someone@example.com.'
                      : 'Messages in this folder will appear here.'
                  }}
                </p>
              </div>
              <article
                v-for="item in items"
                :key="item.id"
                class="mx-mail-row"
                :class="{
                  unread: !item.read,
                  active: message?.id === item.id,
                  checked: selected.includes(item.id)
                }"
                tabindex="0"
                @click="openMessage(item)"
                @keydown.enter="openMessage(item)"
              >
                <div class="mx-row-select" @click.stop>
                  <input
                    v-model="selected"
                    type="checkbox"
                    :value="item.id"
                    :aria-label="'Select ' + item.subject"
                  /><button
                    class="mx-star"
                    :class="{ starred: item.starred }"
                    :aria-label="item.starred ? 'Unstar message' : 'Star message'"
                    @click="star(item)"
                  >
                    <v-icon size="19">{{ item.starred ? 'mdi-star' : 'mdi-star-outline' }}</v-icon>
                  </button>
                </div>
                <div class="mx-row-content">
                  <div class="mx-row-meta">
                    <span>{{ item.draft ? 'Draft' : senderName(item.from) }}</span
                    ><time>{{ shortDate(item.date) }}</time>
                  </div>
                  <h2>
                    {{ item.subject }}
                    <v-icon v-if="item.hasAttachments" size="15">mdi-paperclip</v-icon
                    ><v-icon v-if="item.meeting" size="15">mdi-calendar-outline</v-icon>
                  </h2>
                  <p>{{ item.preview || 'Open message' }}</p>
                  <div v-if="item.labels.length" class="mx-labels">
                    <span v-for="label in item.labels" :key="label">{{ label }}</span>
                  </div>
                </div>
                <span v-if="!item.read" class="mx-unread-dot" />
              </article>
            </div>
          </section>
          <section class="mx-reader" aria-label="Reading pane">
            <template v-if="message"
              ><div class="mx-reader-toolbar">
                <button
                  class="mx-icon-button mx-back"
                  aria-label="Back to messages"
                  @click="message = null"
                >
                  <v-icon>mdi-arrow-left</v-icon></button
                ><button
                  class="mx-icon-button"
                  title="Archive"
                  aria-label="Archive message"
                  @click="archive"
                >
                  <v-icon size="20">mdi-archive-outline</v-icon></button
                ><button
                  class="mx-icon-button"
                  title="Trash"
                  aria-label="Move message to trash"
                  @click="messageAction('trash')"
                >
                  <v-icon size="20">mdi-trash-can-outline</v-icon></button
                ><button
                  class="mx-icon-button"
                  title="Mark unread"
                  aria-label="Mark message unread"
                  @click="messageAction('read', false)"
                >
                  <v-icon size="20">mdi-email-outline</v-icon>
                </button>
                <div class="mx-toolbar-divider" />
                <select
                  aria-label="Move message"
                  @change="
                    messageAction('move', null, $event.target.value);
                    $event.target.value = '';
                  "
                >
                  <option value="">Move to…</option>
                  <option v-for="f in destinations" :key="f.id" :value="f.id">
                    {{ folderLabel(f) }}
                  </option></select
                ><button
                  class="mx-icon-button"
                  aria-label="Edit labels"
                  title="Labels"
                  @click="labelDialog = message.labels.join(', ')"
                >
                  <v-icon size="20">mdi-tag-outline</v-icon></button
                ><button
                  v-if="currentFolder?.type === 4"
                  class="mx-icon-button"
                  title="Delete permanently"
                  aria-label="Delete permanently"
                  @click="deleteDialog = [message.id]"
                >
                  <v-icon size="20">mdi-delete-forever-outline</v-icon>
                </button>
              </div>
              <div class="mx-reader-scroll">
                <div class="mx-message-title">
                  <h1>{{ message.subject }}</h1>
                  <button
                    class="mx-star"
                    :class="{ starred: message.starred }"
                    aria-label="Toggle star"
                    @click="star(message)"
                  >
                    <v-icon size="24">{{
                      message.starred ? 'mdi-star' : 'mdi-star-outline'
                    }}</v-icon>
                  </button>
                </div>
                <div class="mx-sender">
                  <span class="mx-avatar mx-avatar-large">{{
                    initials(senderName(message.from))
                  }}</span>
                  <div>
                    <strong>{{ message.from }}</strong>
                    <p>
                      To: {{ message.to }}<span v-if="message.cc"> · Cc: {{ message.cc }}</span>
                    </p>
                  </div>
                  <time>{{ longDate(message.date) }}</time>
                </div>
                <div v-if="message.invitation?.calendar" class="mx-invitation">
                  <span class="mx-eyebrow">CALENDAR INVITATION</span>
                  <h3>{{ message.invitation.calendar.subject }}</h3>
                  <p>
                    {{ longDate(message.invitation.calendar.start) }} –
                    {{ longDate(message.invitation.calendar.end) }}
                  </p>
                  <p>{{ message.invitation.calendar.location }}</p>
                  <div v-if="message.invitation.calendar.status !== 'CANCELLED'">
                    <button
                      v-for="response in ['ACCEPTED', 'TENTATIVE', 'DECLINED']"
                      :key="response"
                      class="mx-secondary"
                      @click="respond(response)"
                    >
                      {{
                        { ACCEPTED: 'Accept', TENTATIVE: 'Maybe', DECLINED: 'Decline' }[response]
                      }}
                    </button>
                  </div>
                  <p v-else>Meeting cancelled</p>
                  <small v-if="message.invitation.response"
                    >Your response: {{ message.invitation.response.toLowerCase() }}</small
                  >
                </div>
                <div v-if="message.bodyTruncated" class="mx-invitation">
                  <p>This large message is shown as a preview.</p>
                  <button class="mx-secondary" @click="downloadOriginal">
                    Download original message
                  </button>
                </div>
                <div v-if="message.html" class="mx-html-note">
                  <v-icon size="14">mdi-shield-check-outline</v-icon>External images are blocked for
                  privacy.
                  <button
                    v-if="resolvedAppearance === 'dark'"
                    :aria-pressed="originalMessageColours"
                    @click="originalMessageColours = !originalMessageColours"
                  >
                    {{
                      originalMessageColours ? 'Use dark reading colours' : 'Show original colours'
                    }}
                  </button>
                </div>
                <iframe
                  v-if="message.html"
                  :key="message.id"
                  class="mx-message-html"
                  :srcdoc="htmlDocument"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  referrerpolicy="no-referrer"
                  title="Email content"
                />
                <pre v-else class="mx-message-text">{{ message.text }}</pre>
                <div v-if="message.attachments.length" class="mx-attachments">
                  <h3>
                    <v-icon size="18">mdi-paperclip</v-icon
                    >{{ message.attachments.length }} attachments
                  </h3>
                  <button
                    v-for="file in message.attachments"
                    :key="file.index"
                    class="mx-attachment"
                    @click="download(file)"
                  >
                    <v-icon size="25">mdi-file-document-outline</v-icon
                    ><span
                      ><strong>{{ file.filename }}</strong
                      ><small>{{ size(file.size) }}</small></span
                    ><v-icon size="19">mdi-download</v-icon>
                  </button>
                </div>
                <div class="mx-reply-actions">
                  <button class="mx-secondary" @click="reply(false)">
                    <v-icon size="18">mdi-reply</v-icon> Reply</button
                  ><button class="mx-secondary" @click="reply(true)">
                    <v-icon size="18">mdi-reply-all</v-icon> Reply all</button
                  ><button class="mx-secondary" @click="forward">
                    <v-icon size="18">mdi-share-outline</v-icon> Forward
                  </button>
                </div>
                <div v-if="thread.length > 1" class="mx-thread">
                  <h3>In this conversation</h3>
                  <button
                    v-for="item in thread.filter((m) => m.id !== message.id)"
                    :key="item.id"
                    @click="openMessage(item)"
                  >
                    {{ senderName(item.from) }}<span>{{ item.subject }}</span
                    ><time>{{ shortDate(item.date) }}</time>
                  </button>
                </div>
              </div></template
            >
            <div v-else class="mx-empty mx-reader-empty">
              <span class="mx-empty-icon"><v-icon size="42">mdi-email-open-outline</v-icon></span>
              <h2>A little room to focus.</h2>
              <p>Select a message to read it here.</p>
              <span class="mx-key-hint"><kbd>C</kbd> compose <kbd>/</kbd> search</span>
            </div>
          </section>
        </div>
      </template>
      <section v-else-if="view === 'calendar'" class="mx-calendar">
        <div class="mx-page-heading">
          <div>
            <span class="mx-eyebrow">YOUR SCHEDULE</span>
            <h1>{{ monthTitle }}</h1>
            <p>{{ preferences.timeZone || 'UTC' }}</p>
          </div>
          <div class="mx-calendar-controls">
            <button
              class="mx-secondary"
              @click="
                calendarMonth = new Date();
                loadCalendar();
              "
            >
              Today</button
            ><button class="mx-icon-button" aria-label="Previous month" @click="shiftMonth(-1)">
              <v-icon>mdi-chevron-left</v-icon></button
            ><button class="mx-icon-button" aria-label="Next month" @click="shiftMonth(1)">
              <v-icon>mdi-chevron-right</v-icon></button
            ><button class="mx-primary" @click="newEvent()">
              <v-icon size="18">mdi-plus</v-icon>New event
            </button>
          </div>
        </div>
        <div class="mx-calendar-grid">
          <div
            v-for="day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']"
            :key="day"
            class="mx-weekday"
          >
            {{ day }}
          </div>
          <div
            v-for="day in calendarDays"
            :key="day.key"
            class="mx-calendar-day"
            :class="{ muted: day.outside, today: day.today }"
            @dblclick="newEvent(day.key)"
          >
            <button
              class="mx-day-number"
              :aria-label="'Create event on ' + day.key"
              @click="newEvent(day.key)"
            >
              {{ day.number }}</button
            ><button
              v-for="event in day.events"
              :key="event.id + event.instance"
              class="mx-calendar-event"
              :class="{ tentative: event.busy === 1 }"
              @click="editEvent(event)"
            >
              <span>{{ event.allDay ? 'All day' : eventTime(event.start) }}</span
              >{{ event.subject }}
            </button>
          </div>
        </div>
      </section>
      <section v-else-if="view === 'contacts'" class="mx-contacts">
        <div class="mx-page-heading">
          <div>
            <span class="mx-eyebrow">YOUR PEOPLE</span>
            <h1>Contacts</h1>
            <p>
              {{ contacts.length }} personal contacts · Company directory available in recipient
              search
            </p>
          </div>
          <button class="mx-primary" @click="contactDialog = {}">
            <v-icon size="18">mdi-plus</v-icon>New contact
          </button>
        </div>
        <input
          v-model="contactQuery"
          class="mx-input mx-contact-search"
          placeholder="Find a contact"
          aria-label="Find a contact"
        />
        <div v-if="!filteredContacts.length" class="mx-empty">
          <v-icon size="40">mdi-account-multiple-outline</v-icon>
          <h2>Keep your people close.</h2>
          <p>Add contacts to find them quickly when you write.</p>
        </div>
        <div class="mx-contact-table">
          <button
            v-for="contact in filteredContacts"
            :key="contact.id"
            @click="contactDialog = { ...contact }"
          >
            <span class="mx-avatar">{{ initials(contact.firstName + ' ' + contact.lastName) }}</span
            ><strong>{{ contact.firstName }} {{ contact.lastName }}</strong
            ><span>{{ contact.email }}</span
            ><span>{{ contact.company }}</span
            ><span>{{ contact.phone }}</span
            ><v-icon size="18">mdi-pencil-outline</v-icon>
          </button>
        </div>
      </section>
    </main>
    <section
      v-if="composer"
      class="mx-composer"
      :class="{ expanded: composerExpanded }"
      role="dialog"
      aria-label="Compose message"
    >
      <header>
        <strong>{{ composer.id ? 'Draft message' : 'New message' }}</strong
        ><span>{{
          saving ? 'Saving…' : dirty ? 'Unsaved changes' : composer.id ? 'Saved to Drafts' : ''
        }}</span
        ><button
          class="mx-icon-button"
          :aria-label="composerExpanded ? 'Restore composer' : 'Expand composer'"
          @click="composerExpanded = !composerExpanded"
        >
          <v-icon size="18">mdi-arrow-expand</v-icon></button
        ><button class="mx-icon-button" aria-label="Save and close composer" @click="closeComposer">
          <v-icon size="20">mdi-close</v-icon>
        </button>
      </header>
      <div class="mx-compose-fields">
        <label
          ><span>To</span
          ><input
            v-model="composer.to"
            aria-label="To"
            @input="
              dirtyCompose;
              suggest($event.target.value);
            "
            @keydown="dirtyCompose"
          /><button @click="showCc = !showCc">Cc / Bcc</button></label
        >
        <div v-if="suggestions.length" class="mx-suggestions">
          <button v-for="person in suggestions" :key="person.email" @click="addRecipient(person)">
            <strong>{{ person.name }}</strong
            ><span>{{ person.email }}</span>
          </button>
        </div>
        <label v-if="showCc"
          ><span>Cc</span
          ><input v-model="composer.cc" aria-label="Cc" @input="dirtyCompose" /></label
        ><label v-if="showCc"
          ><span>Bcc</span
          ><input v-model="composer.bcc" aria-label="Bcc" @input="dirtyCompose" /></label
        ><label
          ><input
            v-model="composer.subject"
            aria-label="Subject"
            placeholder="Subject"
            @input="dirtyCompose"
        /></label>
      </div>
      <textarea
        v-model="composer.text"
        aria-label="Message body"
        placeholder="Write something…"
        @input="dirtyCompose"
      />
      <div class="mx-compose-files">
        <span v-for="(file, index) in composer.attachments" :key="index"
          ><v-icon size="16">mdi-paperclip</v-icon>{{ file.filename
          }}<button
            :aria-label="'Remove ' + file.filename"
            @click="
              composer.attachments.splice(index, 1);
              dirtyCompose();
            "
          >
            ×
          </button></span
        >
      </div>
      <footer>
        <button
          class="mx-primary"
          :disabled="
            sending ||
            uploading ||
            saving ||
            ![composer.to, composer.cc, composer.bcc].some((value) => value?.trim())
          "
          @click="sendMessage"
        >
          {{ sending ? 'Sending…' : 'Send' }}<v-icon size="17">mdi-send-outline</v-icon></button
        ><label class="mx-icon-button" title="Attach files"
          ><v-icon size="21">mdi-paperclip</v-icon
          ><input
            type="file"
            multiple
            class="mx-visually-hidden"
            :disabled="uploading"
            @change="attachFiles" /></label
        ><span>{{ uploading ? 'Encrypting attachments…' : '' }}</span
        ><button
          class="mx-icon-button mx-discard"
          aria-label="Discard draft"
          @click="discardDialog = true"
        >
          <v-icon size="20">mdi-trash-can-outline</v-icon>
        </button>
      </footer>
    </section>
    <div
      v-if="
        folderDialog !== null ||
        labelDialog !== null ||
        deleteDialog ||
        contactDialog ||
        eventDialog ||
        settingsOpen ||
        discardDialog
      "
      class="mx-modal-backdrop"
    >
      <form v-if="folderDialog !== null" class="mx-modal" @submit.prevent="saveFolder">
        <h2>{{ folderDialog.id ? 'Edit folder' : 'New folder' }}</h2>
        <label
          >Folder name<input v-model="folderDialog.name" class="mx-input" required maxlength="255"
        /></label>
        <footer>
          <button v-if="folderDialog.id" type="button" class="mx-danger" @click="saveFolder(true)">
            Remove empty folder</button
          ><button type="button" class="mx-secondary" @click="folderDialog = null">Cancel</button
          ><button class="mx-primary">Save folder</button>
        </footer>
      </form>
      <form v-else-if="labelDialog !== null" class="mx-modal" @submit.prevent="saveLabels">
        <h2>Labels</h2>
        <label>Separate labels with commas<input v-model="labelDialog" class="mx-input" /></label>
        <footer>
          <button type="button" class="mx-secondary" @click="labelDialog = null">Cancel</button
          ><button class="mx-primary">Save labels</button>
        </footer>
      </form>
      <div v-else-if="deleteDialog || discardDialog" class="mx-modal">
        <h2>{{ discardDialog ? 'Discard this draft?' : 'Delete permanently?' }}</h2>
        <p>
          {{
            discardDialog
              ? 'Your unsent message will be removed.'
              : 'These messages will be removed from your mailbox.'
          }}
        </p>
        <footer>
          <button
            class="mx-secondary"
            @click="
              deleteDialog = null;
              discardDialog = false;
            "
          >
            Keep</button
          ><button class="mx-danger" @click="discardDialog ? discard() : permanentlyDelete()">
            Delete
          </button>
        </footer>
      </div>
      <form v-else-if="contactDialog" class="mx-modal" @submit.prevent="saveContact">
        <h2>{{ contactDialog.id ? 'Edit contact' : 'New contact' }}</h2>
        <div class="mx-form-grid">
          <label
            >First name<input v-model="contactDialog.firstName" class="mx-input" required /></label
          ><label>Last name<input v-model="contactDialog.lastName" class="mx-input" /></label>
        </div>
        <label>Email<input v-model="contactDialog.email" class="mx-input" type="email" /></label
        ><label>Phone<input v-model="contactDialog.phone" class="mx-input" /></label
        ><label>Company<input v-model="contactDialog.company" class="mx-input" /></label>
        <footer>
          <button
            v-if="contactDialog.id"
            type="button"
            class="mx-danger"
            @click="saveContact(true)"
          >
            Delete</button
          ><button type="button" class="mx-secondary" @click="contactDialog = null">Cancel</button
          ><button class="mx-primary">Save contact</button>
        </footer>
      </form>
      <form v-else-if="eventDialog" class="mx-modal mx-event-modal" @submit.prevent="saveEvent">
        <h2>{{ eventDialog.id ? 'Event details' : 'New event' }}</h2>
        <label
          >Event title<input
            v-model="eventDialog.subject"
            class="mx-input"
            required
            :disabled="eventReadOnly"
        /></label>
        <div class="mx-form-grid">
          <label
            >Starts<input
              v-model="eventDialog.localStart"
              class="mx-input"
              type="datetime-local"
              required
              :disabled="eventReadOnly" /></label
          ><label
            >Ends<input
              v-model="eventDialog.localEnd"
              class="mx-input"
              type="datetime-local"
              required
              :disabled="eventReadOnly"
          /></label>
        </div>
        <label
          >Time zone<input
            v-model="eventDialog.timeZone"
            class="mx-input"
            list="mx-timezones"
            :disabled="eventReadOnly" /></label
        ><datalist id="mx-timezones">
          <option v-for="zone in timeZones" :key="zone" :value="zone" /></datalist
        ><label class="mx-checkbox"
          ><input v-model="eventDialog.allDay" type="checkbox" :disabled="eventReadOnly" /> All-day
          event (midnight to midnight)</label
        ><label
          >Location<input
            v-model="eventDialog.location"
            class="mx-input"
            :disabled="eventReadOnly" /></label
        ><label
          >Guests (email addresses separated by commas)<input
            v-model="eventDialog.guests"
            class="mx-input"
            :disabled="eventReadOnly" /></label
        ><label
          >Recurrence<select
            v-model="eventDialog.repeat"
            class="mx-input"
            :disabled="eventReadOnly"
          >
            <option value="">Does not repeat</option>
            <option value="DAILY">Every day</option>
            <option value="WEEKLY">Every week</option>
            <option value="MONTHLY">Every month</option>
            <option value="YEARLY">Every year</option>
            <option value="custom">Custom rule</option>
          </select></label
        ><label v-if="eventDialog.repeat === 'custom'"
          >Recurrence rule<input
            v-model="eventDialog.rrule"
            class="mx-input"
            :disabled="eventReadOnly" /></label
        ><label v-else-if="eventDialog.repeat"
          >Number of occurrences<input
            v-model="eventDialog.count"
            class="mx-input"
            type="number"
            min="1"
            max="10000"
            :disabled="eventReadOnly" /></label
        ><label
          >Notes<textarea
            v-model="eventDialog.body"
            class="mx-input"
            rows="3"
            :disabled="eventReadOnly"
          />
        </label>
        <div v-if="!eventReadOnly && eventDialog.proposals" class="mx-proposals">
          <div v-for="(proposal, email) in eventDialog.proposals" :key="email">
            <strong>{{ email }} proposed a new time</strong>
            <p>{{ longDate(proposal.start) }} – {{ longDate(proposal.end) }}</p>
            <button type="button" class="mx-secondary" @click="useProposal(email, proposal)">
              Use proposed time</button
            ><button type="button" class="mx-secondary" @click="declineProposal(email)">
              Decline proposal
            </button>
          </div>
        </div>
        <div v-if="eventDialog.attendees?.length" class="mx-attendees">
          <span v-for="person in eventDialog.attendees" :key="person.email"
            >{{ person.email
            }}<small>{{
              (person.status || 'NEEDS-ACTION').toLowerCase().replace('-', ' ')
            }}</small></span
          >
        </div>
        <footer>
          <button
            v-if="eventDialog.id && !eventReadOnly"
            type="button"
            class="mx-danger"
            @click="cancelEvent"
          >
            Cancel meeting</button
          ><button type="button" class="mx-secondary" @click="eventDialog = null">Close</button
          ><button v-if="!eventReadOnly" class="mx-primary">
            {{ eventDialog.guests ? 'Save & send invitations' : 'Save event' }}</button
          ><button v-else type="button" class="mx-primary" @click="calendarAccept">
            Accept invitation
          </button>
        </footer>
      </form>
      <form v-else-if="settingsOpen" class="mx-modal" @submit.prevent="saveSettings">
        <h2>Make it yours</h2>
        <p>Preferences for {{ mailboxEmail }}</p>
        <label
          >Appearance<select v-model="preferences.appearance" class="mx-input" aria-label="Appearance">
            <option value="system">Use device setting</option>
            <option value="light">Light · lavender</option>
            <option value="dark">Dark · purple</option>
          </select></label
        >
        <label
          >Time zone<input
            v-model="preferences.timeZone"
            class="mx-input"
            list="mx-settings-timezones"
            required /></label
        ><datalist id="mx-settings-timezones">
          <option v-for="zone in timeZones" :key="zone" :value="zone" /></datalist
        ><label
          >Message density<select v-model="preferences.density" class="mx-input">
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select></label
        ><label
          >Signature<textarea v-model="preferences.signature" class="mx-input" rows="5" /></label
        ><NuxtLink class="mx-settings-link" to="/coremx"
          >Manage connected devices <v-icon size="18">mdi-arrow-top-right</v-icon></NuxtLink
        >
        <footer>
          <button type="button" class="mx-secondary" @click="settingsOpen = false">Close</button
          ><button class="mx-primary">Save preferences</button>
        </footer>
      </form>
    </div>
  </div>
</template>
<script>
const localDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export default {
  data: () => ({
    boxes: [],
    mailboxId: '',
    admin: false,
    overview: { folders: [] },
    preferences: { timeZone: 'UTC', density: 'comfortable', signature: '', appearance: 'system' },
    systemDark: false,
    originalMessageColours: false,
    view: 'mail',
    tabs: [
      { id: 'mail', label: 'Mail', icon: 'mdi-email-outline' },
      { id: 'calendar', label: 'Calendar', icon: 'mdi-calendar-blank-outline' },
      { id: 'contacts', label: 'Contacts', icon: 'mdi-account-multiple-outline' }
    ],
    folderId: '',
    starred: false,
    unreadOnly: false,
    query: '',
    searchActive: false,
    items: [],
    total: 0,
    offset: 0,
    selected: [],
    message: null,
    thread: [],
    loading: true,
    error: '',
    notice: '',
    mobileNav: false,
    composer: null,
    composerExpanded: false,
    showCc: false,
    dirty: false,
    saving: false,
    sending: false,
    uploading: false,
    suggestions: [],
    contacts: [],
    contactQuery: '',
    contactDialog: null,
    calendarMonth: new Date(),
    events: [],
    eventDialog: null,
    folderDialog: null,
    labelDialog: null,
    deleteDialog: null,
    discardDialog: false,
    settingsOpen: false,
    timeZones: [],
    requestGeneration: 0
  }),
  computed: {
    resolvedAppearance() {
      return this.preferences.appearance === 'system'
        ? this.systemDark
          ? 'dark'
          : 'light'
        : this.preferences.appearance;
    },
    mailboxEmail() {
      return this.boxes.find((b) => b.id === this.mailboxId)?.email || '';
    },
    mailFolders() {
      return this.overview.folders
        .filter((f) => f.class === 'Email' && f.type !== 6)
        .sort(
          (a, b) =>
            (({ 2: 0, 3: 1, 5: 2, 4: 9 })[a.type] ?? 5) - ({ 2: 0, 3: 1, 5: 2, 4: 9 }[b.type] ?? 5)
        );
    },
    destinations() {
      return this.mailFolders.filter((f) => f.type !== 3);
    },
    currentFolder() {
      return this.overview.folders.find((f) => f.id === this.folderId);
    },
    inboxUnread() {
      return this.overview.folders.find((f) => f.type === 2)?.unread || 0;
    },
    htmlDocument() {
      const dark = this.resolvedAppearance === 'dark' && !this.originalMessageColours;
      const colours = dark
        ? 'body{background:#211a2c;color:#d1c4e0}body *{color:inherit!important;background-color:transparent!important;border-color:#44364f!important}a,a *{color:#c19af2!important}'
        : 'body{background:#ffffff;color:#2e203c}a{color:#7241ac}';
      return (
        '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><style>body{font:15px/1.65 system-ui,sans-serif;margin:0;padding:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}' +
        colours +
        '</style></head><body>' +
        (this.message?.html || '') +
        '</body></html>'
      );
    },
    monthTitle() {
      return this.calendarMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    },
    calendarDays() {
      const first = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth(), 1);
      first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
      return Array.from({ length: 42 }, (_, i) => {
        const d = new Date(first);
        d.setDate(d.getDate() + i);
        const key = localDate(d);
        return {
          key,
          number: d.getDate(),
          outside: d.getMonth() !== this.calendarMonth.getMonth(),
          today: key === localDate(new Date()),
          events: this.events.filter((e) => this.dateInZone(e.start) === key)
        };
      });
    },
    filteredContacts() {
      const q = this.contactQuery.toLowerCase();
      return this.contacts.filter((c) =>
        [c.firstName, c.lastName, c.email, c.company].join(' ').toLowerCase().includes(q)
      );
    },
    eventReadOnly() {
      return this.eventDialog?.id && this.eventDialog.organizer?.email !== this.mailboxEmail;
    }
  },
  watch: {
    'preferences.appearance'() {
      this.applyAppearance();
    }
  },
  async mounted() {
    this.appearanceMedia = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark = this.appearanceMedia.matches;
    this.appearanceMedia.addEventListener('change', this.systemAppearanceChanged);
    try {
      const saved = localStorage.getItem('coremx.appearance');
      if (['light', 'dark', 'system'].includes(saved)) this.preferences.appearance = saved;
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
    this.applyAppearance();
    this.timeZones = Intl.supportedValuesOf?.('timeZone') || ['UTC', 'Europe/London'];
    if (!this.timeZones.includes('UTC')) this.timeZones.unshift('UTC');
    this.preferences.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('beforeunload', this.beforeUnload);
    await this.run(async () => {
      const state = await this.api('list', {}, false);
      this.boxes = state.ownedMailboxes || state.mailboxes;
      this.admin = state.admin;
      this.mailboxId = this.boxes[0]?.id || '';
      if (this.mailboxId) await this.changeMailbox();
    });
    this.loading = false;
    this.refreshTimer = setInterval(() => {
      if (!this.composer && !this.loading && document.visibilityState === 'visible') this.refresh();
    }, 60000);
  },
  beforeUnmount() {
    this.appearanceMedia?.removeEventListener('change', this.systemAppearanceChanged);
    clearInterval(this.refreshTimer);
    clearTimeout(this.draftTimer);
    clearTimeout(this.suggestTimer);
    clearTimeout(this.noticeTimer);
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('beforeunload', this.beforeUnload);
  },
  methods: {
    systemAppearanceChanged(event) {
      this.systemDark = event.matches;
    },
    applyAppearance() {
      const appearance = this.preferences.appearance;
      try {
        localStorage.setItem('coremx.appearance', appearance);
      } catch {
        /* Appearance still works without browser storage. */
      }
      window.dispatchEvent(new CustomEvent('coremx-appearance', { detail: appearance }));
    },
    async toggleAppearance() {
      this.preferences.appearance = this.resolvedAppearance === 'dark' ? 'light' : 'dark';
      if (this.mailboxId)
        await this.run(async () => {
          await this.api('preferences', this.preferences);
        });
    },
    async api(handle, data = {}, mail = true) {
      const response = await this.$dcsajax({
        Controller: 'coremx',
        handle: mail ? 'mail.' + handle : handle,
        data: { ...data, ...(mail ? { mailbox: this.mailboxId } : {}) }
      });
      if (response.status !== 100)
        throw new Error(response.payload?.msg || 'Unable to complete request');
      return response.payload;
    },
    async run(fn) {
      this.error = '';
      try {
        return await fn();
      } catch (e) {
        this.error = e.message;
        return null;
      }
    },
    toast(text) {
      this.notice = text;
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => (this.notice = ''), 4000);
    },
    async changeMailbox() {
      if (this.composer) {
        this.mailboxId = this.composer.mailbox;
        this.error = 'Save and close your draft before switching mailboxes.';
        return;
      }
      this.message = null;
      this.folderId = '';
      this.query = '';
      this.starred = false;
      this.overview = await this.api('overview');
      this.preferences = {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        density: 'comfortable',
        signature: '',
        appearance: 'system',
        ...this.overview.preferences
      };
      this.folderId = this.overview.folders.find((f) => f.type === 2)?.id;
      await this.refresh();
    },
    async refresh() {
      if (!this.mailboxId) return;
      await this.run(async () => {
        this.overview = await this.api('overview');
        if (this.view === 'mail') await this.loadMessages(false);
        else if (this.view === 'calendar') await this.loadCalendar();
        else await this.loadContacts();
      });
    },
    async switchView(view) {
      this.view = view;
      this.mobileNav = false;
      await this.refresh();
    },
    async chooseFolder(id, starred = false) {
      this.folderId = id;
      this.starred = starred;
      this.query = '';
      this.searchActive = false;
      this.message = null;
      this.mobileNav = false;
      this.view = 'mail';
      await this.loadMessages();
    },
    async searchMail() {
      this.view = 'mail';
      this.searchActive = !!this.query.trim();
      this.message = null;
      await this.loadMessages();
    },
    async loadMessages(reset = true) {
      if (reset) this.offset = 0;
      this.selected = [];
      this.loading = true;
      const generation = ++this.requestGeneration;
      await this.run(async () => {
        const result = await this.api('list', {
          folder: this.searchActive || this.starred ? undefined : this.folderId,
          query: this.query,
          starred: this.starred,
          unread: this.unreadOnly,
          offset: this.offset
        });
        if (generation === this.requestGeneration) {
          this.items = result.items;
          this.total = result.total;
        }
      });
      if (generation === this.requestGeneration) this.loading = false;
    },
    async openMessage(item) {
      this.originalMessageColours = false;
      if (item.draft) {
        if (this.composer) {
          this.toast('Finish or close your current draft first.');
          return;
        }
        await this.run(async () => {
          const m = await this.api('read', { id: item.id, peek: true });
          if (m.bodyTruncated)
            throw new Error(
              'This draft is too large for the web composer. Edit it using your mail client.'
            );
          this.composer = {
            ...m,
            mailbox: this.mailboxId,
            clientId: crypto.randomUUID(),
            attachments: m.attachments.map((a) => ({ ...a, message: m.id }))
          };
          this.showCc = !!(m.cc || m.bcc);
          this.dirty = false;
        });
        return;
      }
      this.message = null;
      const id = item.id;
      this.readingId = id;
      await this.run(async () => {
        const m = await this.api('read', { id });
        if (this.readingId !== id) return;
        this.message = m;
        item.read = true;
        this.overview = await this.api('overview');
        const thread = await this.api('thread', { id: m.id });
        if (this.readingId === id) this.thread = thread.items;
      });
    },
    async star(item) {
      await this.run(async () => {
        await this.api('mutate', { ids: [item.id], action: 'star', value: !item.starred });
        item.starred = !item.starred;
        const row = this.items.find((m) => m.id === item.id);
        if (row) row.starred = item.starred;
      });
    },
    async bulk(action, value, folder) {
      if (!this.selected.length || (action === 'move' && !folder)) return;
      await this.run(async () => {
        await this.api('mutate', { ids: this.selected, action, value, folder });
        this.message = null;
        await this.refresh();
      });
    },
    async messageAction(action, value, folder) {
      if (!this.message || (action === 'move' && !folder)) return;
      await this.run(async () => {
        await this.api('mutate', { ids: [this.message.id], action, value, folder });
        if (['trash', 'move'].includes(action) || (action === 'read' && !value))
          this.message = null;
        await this.refresh();
      });
    },
    async archive() {
      await this.run(async () => {
        let folder = this.overview.folders.find((f) => f.name === 'Archive');
        if (!folder) folder = await this.api('folder', { name: 'Archive' });
        await this.messageAction('move', null, folder.id);
      });
    },
    newMessage() {
      if (this.composer) return;
      this.composer = {
        mailbox: this.mailboxId,
        to: '',
        cc: '',
        bcc: '',
        subject: '',
        text: this.preferences.signature ? '\n\n' + this.preferences.signature : '',
        attachments: [],
        clientId: crypto.randomUUID()
      };
      this.dirty = false;
      this.showCc = false;
      this.mobileNav = false;
    },
    reply(all) {
      if (this.composer) return;
      const m = this.message;
      this.newMessage();
      this.composer.to = m.replyTo;
      this.composer.cc = all
        ? [m.to, m.cc]
            .filter(Boolean)
            .join(', ')
            .split(',')
            .filter((v) => !v.includes(this.mailboxEmail) && !m.replyTo.includes(v.trim()))
            .join(', ')
        : '';
      this.showCc = !!this.composer.cc;
      this.composer.subject = /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject;
      this.composer.text +=
        '\n\nOn ' +
        this.longDate(m.date) +
        ', ' +
        m.from +
        ' wrote:\n' +
        m.text
          .split('\n')
          .map((s) => '> ' + s)
          .join('\n');
      this.composer.source = m.id;
      this.dirtyCompose();
    },
    forward() {
      if (this.composer) return;
      const m = this.message;
      this.newMessage();
      Object.assign(this.composer, {
        subject: 'Fwd: ' + m.subject,
        source: m.id,
        forward: true,
        text:
          this.composer.text +
          '\n\n---------- Forwarded message ----------\nFrom: ' +
          m.from +
          '\nTo: ' +
          m.to +
          '\nSubject: ' +
          m.subject +
          '\n\n' +
          m.text,
        attachments: m.attachments.map((a) => ({ ...a, message: m.id }))
      });
      this.dirtyCompose();
    },
    dirtyCompose() {
      this.dirty = true;
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => this.run(() => this.saveDraft()), 1500);
    },
    async saveDraft() {
      clearTimeout(this.draftTimer);
      if (this.saving) {
        await this.savePromise;
        return this.dirty ? this.saveDraft() : undefined;
      }
      if (!this.composer || !this.dirty || this.uploading) return;
      this.saving = true;
      this.dirty = false;
      const snapshot = { ...this.composer, attachments: [...this.composer.attachments] };
      this.savePromise = this.api('draft', snapshot);
      try {
        const saved = await this.savePromise;
        if (this.composer) {
          this.composer.id = saved.id;
          this.composer.revision = saved.revision;
          if (!this.dirty)
            this.composer.attachments = saved.attachments.map((a) => ({ ...a, message: saved.id }));
        }
      } catch (e) {
        this.dirty = true;
        throw e;
      } finally {
        this.saving = false;
      }
      if (this.dirty) return this.saveDraft();
    },
    async closeComposer() {
      await this.run(async () => {
        await this.saveDraft();
        this.composer = null;
        this.suggestions = [];
        await this.refresh();
      });
    },
    async sendMessage() {
      this.sending = true;
      await this.run(async () => {
        await this.saveDraft();
        await this.api('send', this.composer);
        this.composer = null;
        this.suggestions = [];
        this.toast('Message queued for delivery');
        await this.refresh();
      });
      this.sending = false;
    },
    async discard() {
      clearTimeout(this.draftTimer);
      await this.run(async () => {
        if (this.saving) await this.savePromise;
        if (this.composer.id)
          await this.api('mutate', { ids: [this.composer.id], action: 'delete' });
        this.composer = null;
        this.dirty = false;
        this.discardDialog = false;
        await this.refresh();
      });
    },
    suggest(text) {
      clearTimeout(this.suggestTimer);
      this.dirtyCompose();
      const query = text.split(',').at(-1).trim();
      if (query.length < 2) {
        this.suggestions = [];
        return;
      }
      this.suggestTimer = setTimeout(
        () =>
          this.run(async () => {
            const result = await this.api('recipients', { query });
            if (this.composer?.to.split(',').at(-1).trim() === query)
              this.suggestions = result.items;
          }),
        250
      );
    },
    addRecipient(person) {
      this.composer.to =
        this.composer.to.split(',').slice(0, -1).concat(person.email).join(', ') + ', ';
      this.suggestions = [];
      this.dirtyCompose();
    },
    async attachFiles(event) {
      const files = [...event.target.files];
      event.target.value = '';
      this.uploading = true;
      await this.run(async () => {
        for (const file of files) {
          if (file.size > 24 * 1024 * 1024)
            throw new Error('Attachments must be 24 MiB or smaller to fit in a mail message.');
          let id;
          const bytes = new Uint8Array(await file.arrayBuffer());
          for (
            let offset = 0, index = 0;
            offset < bytes.length || index === 0;
            offset += 384 * 1024, index++
          ) {
            const chunk = bytes.subarray(offset, offset + 384 * 1024);
            let binary = '';
            for (let i = 0; i < chunk.length; i += 8192)
              binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
            const result = await this.api('upload', {
              id,
              index,
              filename: file.name,
              contentType: file.type,
              base64: btoa(binary)
            });
            id = result.id;
          }
          this.composer.attachments.push({ upload: id, filename: file.name, size: file.size });
        }
      });
      this.uploading = false;
      this.dirtyCompose();
    },
    async downloadOriginal() {
      await this.run(async () => {
        const parts = [];
        let total = 1;
        for (let offset = 0; offset < total; offset += 384 * 1024) {
          const result = await this.api('raw', { id: this.message.id, offset });
          total = result.total;
          parts.push(Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0)));
        }
        const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'message.eml';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    },
    async download(file) {
      await this.run(async () => {
        const parts = [];
        for (let offset = 0; offset < file.size || offset === 0; offset += 384 * 1024) {
          const result = await this.api('attachment', {
            id: this.message.id,
            index: file.index,
            offset
          });
          parts.push(Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0)));
          if (!file.size) break;
        }
        const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = file.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    },
    async saveFolder(remove = false) {
      await this.run(async () => {
        const result = await this.api('folder', { ...this.folderDialog, remove: remove === true });
        this.folderDialog = null;
        await this.refresh();
        if (!remove) await this.chooseFolder(result.id);
      });
    },
    async saveLabels() {
      await this.messageAction(
        'label',
        this.labelDialog
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      if (!this.error) {
        this.message.labels = this.labelDialog
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        this.labelDialog = null;
      }
    },
    async permanentlyDelete() {
      await this.run(async () => {
        await this.api('mutate', { ids: this.deleteDialog, action: 'delete' });
        this.deleteDialog = null;
        this.message = null;
        await this.refresh();
      });
    },
    async respond(response) {
      await this.run(async () => {
        await this.api('calendarRespond', { id: this.message.id, response });
        this.message.invitation.response = response;
        this.toast('Response sent to the organizer');
      });
    },
    async loadContacts() {
      this.contacts = (await this.api('contacts')).items;
    },
    async saveContact(remove = false) {
      await this.run(async () => {
        await this.api('contacts', {
          ...this.contactDialog,
          action: remove === true ? 'delete' : 'save'
        });
        this.contactDialog = null;
        await this.loadContacts();
      });
    },
    shiftMonth(amount) {
      this.calendarMonth = new Date(
        this.calendarMonth.getFullYear(),
        this.calendarMonth.getMonth() + amount,
        1
      );
      this.run(() => this.loadCalendar());
    },
    async loadCalendar() {
      const days = this.calendarDays;
      this.events = (
        await this.api('calendarList', {
          from: days[0].key + 'T00:00:00Z',
          to: new Date(Date.parse(days.at(-1).key) + 2 * 86400000).toISOString()
        })
      ).items;
    },
    newEvent(day) {
      this.eventDialog = {
        uid: crypto.randomUUID(),
        subject: '',
        localStart: (day || localDate(new Date())) + 'T09:00',
        localEnd: (day || localDate(new Date())) + 'T10:00',
        timeZone: this.preferences.timeZone || 'UTC',
        allDay: false,
        location: '',
        guests: '',
        body: '',
        repeat: '',
        count: 12,
        attendees: [],
        exceptions: [],
        busy: 2,
        sequence: 0,
        clientId: crypto.randomUUID()
      };
    },
    async editEvent(event) {
      await this.run(async () => {
        const item = await this.api('calendarGet', { id: event.id });
        const e = item.calendar;
        this.eventDialog = {
          ...e,
          id: item.id,
          revision: item.revision,
          timeZone: e.timezone ? 'Original device time zone' : e.timeZone || 'UTC',
          localStart: item.wallStart.slice(0, 16),
          localEnd: item.wallEnd.slice(0, 16),
          proposalWallTimes: item.proposalWallTimes,
          guests: e.attendees.map((a) => a.email).join(', '),
          repeat: e.rrule ? 'custom' : '',
          count: 12,
          clientId: crypto.randomUUID()
        };
      });
    },
    useProposal(email, proposal) {
      const e = this.eventDialog;
      const wall =
        e.timezone && e.timeZone === 'Original device time zone' && e.proposalWallTimes[email];
      e.localStart = wall ? wall.start.slice(0, 16) : this.localTime(proposal.start, e.timeZone);
      e.localEnd = wall ? wall.end.slice(0, 16) : this.localTime(proposal.end, e.timeZone);
    },
    async saveEvent() {
      await this.run(async () => {
        const e = this.eventDialog;
        const attendees = e.guests
          .split(',')
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean)
          .map(
            (email) =>
              e.attendees.find((a) => a.email === email) || {
                email,
                status: 'NEEDS-ACTION',
                role: 1
              }
          );
        const date = new Date(e.localStart + 'Z'),
          day = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][date.getUTCDay()];
        const suffix = {
          DAILY: '',
          WEEKLY: ';BYDAY=' + day,
          MONTHLY: ';BYMONTHDAY=' + date.getUTCDate(),
          YEARLY: ';BYMONTH=' + (date.getUTCMonth() + 1) + ';BYMONTHDAY=' + date.getUTCDate()
        }[e.repeat];
        const rrule =
          e.repeat === 'custom'
            ? e.rrule
            : e.repeat
              ? 'FREQ=' + e.repeat + ';COUNT=' + Number(e.count) + suffix
              : null;
        await this.api('calendarSave', {
          ...e,
          localStart: e.localStart + ':00',
          localEnd: e.localEnd + ':00',
          attendees,
          rrule,
          keepNativeZone: !!e.timezone && e.timeZone === 'Original device time zone',
          timezone: null
        });
        this.eventDialog = null;
        await this.loadCalendar();
        this.toast(attendees.length ? 'Event saved and invitations queued' : 'Event saved');
      });
    },
    async declineProposal(email) {
      await this.run(async () => {
        await this.api('calendarDeclineProposal', {
          id: this.eventDialog.id,
          email,
          revision: this.eventDialog.revision
        });
        const item = await this.api('calendarGet', { id: this.eventDialog.id });
        this.eventDialog.revision = item.revision;
        this.eventDialog.proposals = item.calendar.proposals;
        this.toast('Proposal declined');
      });
    },
    async cancelEvent() {
      await this.run(async () => {
        await this.api('calendarCancel', {
          id: this.eventDialog.id,
          revision: this.eventDialog.revision
        });
        this.eventDialog = null;
        await this.loadCalendar();
        this.toast('Cancellation sent');
      });
    },
    async calendarAccept() {
      await this.run(async () => {
        await this.api('calendarRespond', { id: this.eventDialog.id, response: 'ACCEPTED' });
        this.eventDialog = null;
        await this.loadCalendar();
        this.toast('Invitation accepted');
      });
    },
    async saveSettings() {
      await this.run(async () => {
        this.preferences = await this.api('preferences', this.preferences);
        this.settingsOpen = false;
        this.toast('Preferences saved');
      });
    },
    beforeUnload(event) {
      if (this.dirty || this.saving || this.uploading) {
        event.preventDefault();
        event.returnValue = '';
      }
    },
    keydown(event) {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) ||
        event.target.isContentEditable
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        document.querySelector('.mx-search input')?.focus();
      }
      if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        this.newMessage();
      }
      if (event.key === 'Escape') {
        this.mobileNav = false;
        this.message = null;
      }
    },
    folderLabel(folder) {
      return (
        { 2: 'Inbox', 3: 'Drafts', 4: 'Trash', 5: 'Sent' }[folder?.type] || folder?.name || 'Mail'
      );
    },
    folderIcon(folder) {
      return (
        {
          2: 'mdi-inbox-outline',
          3: 'mdi-file-document-edit-outline',
          4: 'mdi-trash-can-outline',
          5: 'mdi-send-outline'
        }[folder.type] ||
        (folder.name === 'Junk'
          ? 'mdi-alert-octagon-outline'
          : folder.name === 'Archive'
            ? 'mdi-archive-outline'
            : 'mdi-folder-outline')
      );
    },
    senderName(text) {
      return (
        String(text || 'Unknown sender')
          .replace(/<[^>]+>/g, '')
          .replace(/"/g, '')
          .trim() || text
      );
    },
    initials(text) {
      return String(text || 'M')
        .split(/[ @.]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0].toUpperCase())
        .join('');
    },
    size(value) {
      return value >= 1024 ** 3
        ? (value / 1024 ** 3).toFixed(1) + ' GB'
        : value >= 1024 ** 2
          ? (value / 1024 ** 2).toFixed(1) + ' MB'
          : value >= 1024
            ? Math.ceil(value / 1024) + ' KB'
            : value + ' B';
    },
    shortDate(value) {
      const date = new Date(value);
      return localDate(date) === localDate(new Date())
        ? date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    },
    longDate(value) {
      return new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: this.preferences.timeZone || 'UTC'
      });
    },
    eventTime(value) {
      return new Date(value).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: this.preferences.timeZone || 'UTC'
      });
    },
    dateInZone(value) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: this.preferences.timeZone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date(value));
    },
    localTime(value, zone) {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: zone || this.preferences.timeZone || 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        })
          .formatToParts(new Date(value))
          .map((p) => [p.type, p.value])
      );
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    }
  }
};
</script>
<style src="~/assets/coremx-webmail.css"></style>
