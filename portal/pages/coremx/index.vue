<template>
  <v-container style="max-width: 1100px">
    <div class="d-flex align-center justify-space-between my-6">
      <div>
        <h1>Mail administration</h1>
        <p>Domains, mailboxes, device security and delivery</p>
      </div>
      <v-btn :loading="busy" @click="refresh">Refresh</v-btn>
    </div>
    <v-alert v-if="error" type="error" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="secret" type="success" class="mb-4" closable @click:close="secret = ''"
      >Save this device password now. It is shown once.
      <pre class="mt-2" style="white-space: pre-wrap; overflow-wrap: anywhere">{{ secret }}</pre>
    </v-alert>
    <v-card v-if="state.admin" class="mb-6 pa-5" title="Mail domains">
      <v-chip v-for="domain in state.domains" :key="domain.id" class="ma-1">{{ domain.name }}</v-chip>
      <v-form class="d-flex ga-3 mt-4" @submit.prevent="mutate('createDomain', { domain })"
        ><v-text-field v-model="domain" label="Domain" placeholder="example.com" /><v-btn
          type="submit"
          :disabled="busy"
          >Add domain</v-btn
        ></v-form
      >
    </v-card>
    <v-card v-if="state.admin" class="mb-6 pa-5" title="Create mailbox">
      <v-form
        @submit.prevent="mutate('createMailbox', { email, owner, quotaBytes: Number(quota) * 1024 * 1024 })"
      >
        <v-row
          ><v-col><v-text-field v-model="email" label="Email address" /></v-col
          ><v-col
            ><v-select
              v-model="owner"
              :items="state.users"
              item-title="label"
              item-value="id"
              label="Mailbox owner" /></v-col
          ><v-col><v-text-field v-model="quota" type="number" label="Quota (MiB)" /></v-col></v-row
        ><v-btn type="submit" :disabled="busy">Create mailbox</v-btn>
      </v-form>
    </v-card>
    <v-card v-for="mailbox in state.mailboxes" :key="mailbox.id" class="mb-5 pa-5">
      <div class="d-flex align-center justify-space-between">
        <h2>{{ mailbox.email }}</h2>
        <div>
          <v-btn
            v-if="state.admin"
            variant="text"
            @click="
              policyBox = mailbox;
              policy = JSON.stringify(mailbox.devicePolicy || defaults, null, 2);
            "
            >Device policy</v-btn
          ><v-btn
            v-if="state.admin"
            variant="text"
            @click="editBox = { ...mailbox, quotaMiB: Math.ceil(mailbox.quotaBytes / 1048576) }"
            >Edit mailbox</v-btn
          >
        </div>
      </div>
      <p class="mb-4">
        {{ Math.ceil(mailbox.usedBytes / 1024 / 1024) }} MiB used ·
        {{ Math.ceil(mailbox.quotaBytes / 1024 / 1024) }} MiB quota
      </p>
      <v-form
        class="d-flex ga-3"
        @submit.prevent="mutate('issueDevice', { mailbox: mailbox.id, label: labels[mailbox.id] })"
        ><v-text-field v-model="labels[mailbox.id]" label="Device name" placeholder="My phone" /><v-btn
          type="submit"
          :disabled="busy"
          >Create device password</v-btn
        ></v-form
      >
      <v-list
        ><v-list-item
          v-for="device in state.devices.filter((d) => d.mailbox === mailbox.id)"
          :key="device.id"
          :title="device.label"
          :subtitle="
            device.wipe
              ? 'Account wipe: ' + device.wipe.status
              : device.revoked
                ? 'Revoked'
                : (device.protocolVersion ? 'EAS ' + device.protocolVersion : 'Not connected yet') +
                  (device.policyKey ? ' · Provisioned' : ' · Provisioning required')
          "
          ><template #append
            ><v-btn
              v-if="!device.revoked && device.protocolVersion === '16.1' && !device.wipe"
              variant="text"
              color="warning"
              :disabled="busy"
              @click="wipeDevice = device"
              >Wipe account</v-btn
            ><v-btn
              v-if="!device.revoked"
              color="error"
              variant="text"
              :disabled="busy"
              @click="mutate('revokeDevice', { device: device.id })"
              >Revoke</v-btn
            ></template
          ></v-list-item
        ></v-list
      >
    </v-card>
    <v-card v-if="state.admin" class="mb-6 pa-5" title="Address aliases">
      <v-list
        ><v-list-item
          v-for="alias in state.aliases"
          :key="alias.id"
          :title="alias.email"
          :subtitle="alias.target"
      /></v-list>
      <v-form
        class="d-flex ga-3"
        @submit.prevent="mutate('createAlias', { email: aliasEmail, target: aliasTarget })"
        ><v-text-field v-model="aliasEmail" label="Alias address" /><v-select
          v-model="aliasTarget"
          :items="state.mailboxes"
          item-title="email"
          item-value="email"
          label="Deliver to"
        /><v-btn type="submit" :disabled="busy">Add alias</v-btn></v-form
      >
    </v-card>
    <v-dialog :model-value="!!wipeDevice" max-width="520" @update:model-value="wipeDevice = null"
      ><v-card v-if="wipeDevice" title="Remove this mail account from the device"
        ><v-card-text
          ><p>
            CoreMX will ask {{ wipeDevice.label }} to remove this account's mail and calendar data on its next
            connection, then revoke its device password.
          </p>
          <p class="mt-3">
            The server mailbox is retained. Other accounts and personal device data are unaffected.
          </p>
          <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn @click="wipeDevice = null">Cancel</v-btn
          ><v-btn color="warning" :loading="busy" @click="wipeAccount"
            >Request account wipe</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog :model-value="!!policyBox" max-width="700" @update:model-value="policyBox = null"
      ><v-card v-if="policyBox" title="Device provisioning policy"
        ><v-card-text
          ><p class="mb-3">
            Devices must acknowledge the complete policy before they can sync. Changing this policy requires
            connected devices to provision again.
          </p>
          <v-textarea
            v-model="policy"
            label="ActiveSync policy settings (JSON)"
            rows="18"
            spellcheck="false"
          />
          <p>
            Password and hardware restrictions are applied by the device. CoreMX enforces policy keys, expiry,
            attachment access, mail format and sync limits.
          </p>
          <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn @click="policyBox = null">Cancel</v-btn
          ><v-btn color="primary" :loading="busy" @click="savePolicy">Apply policy</v-btn></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog :model-value="!!editBox" max-width="480" @update:model-value="editBox = null"
      ><v-card v-if="editBox" title="Mailbox settings"
        ><v-card-text
          ><v-switch v-model="editBox.enabled" label="Mailbox enabled" color="primary" /><v-text-field
            v-model="editBox.quotaMiB"
            label="Quota (MiB)"
            type="number"
            min="1" /></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn @click="editBox = null">Cancel</v-btn
          ><v-btn :loading="busy" @click="saveMailbox">Save</v-btn></v-card-actions
        ></v-card
      ></v-dialog
    >
    <p v-if="!state.mailboxes.length && !busy">Sign in with a passkey to view your mailboxes.</p>
  </v-container>
</template>
<script>
export default {
  data: () => ({
    state: { mailboxes: [], devices: [], domains: [], users: [], admin: false },
    busy: false,
    error: '',
    secret: '',
    domain: '',
    email: '',
    owner: '',
    quota: 1024,
    labels: {},
    aliasEmail: '',
    aliasTarget: '',
    wipeDevice: null,
    policyBox: null,
    policy: '',
    editBox: null,
    defaults: {
      DevicePasswordEnabled: 1,
      MinDevicePasswordLength: 6,
      MaxInactivityTimeDeviceLock: 900,
      MaxDevicePasswordFailedAttempts: 10,
      AllowSimpleDevicePassword: 0,
      AttachmentsEnabled: 1,
      MaxAttachmentSize: 33554432,
      AllowHTMLEmail: 1,
      MaxEmailAgeFilter: 0,
      MaxCalendarAgeFilter: 0
    }
  }),
  mounted() {
    this.refresh();
  },
  beforeUnmount() {
    this.secret = '';
  },
  methods: {
    async wipeAccount() {
      await this.mutate('requestAccountWipe', { device: this.wipeDevice.id });
      if (!this.error) this.wipeDevice = null;
    },
    async savePolicy() {
      try {
        const policy = JSON.parse(this.policy);
        await this.mutate('setDevicePolicy', { mailbox: this.policyBox.id, policy });
        if (!this.error) this.policyBox = null;
      } catch (e) {
        this.error = e.message;
      }
    },
    async saveMailbox() {
      await this.mutate('updateMailbox', {
        mailbox: this.editBox.id,
        enabled: this.editBox.enabled,
        quotaBytes: Number(this.editBox.quotaMiB) * 1048576
      });
      if (!this.error) this.editBox = null;
    },
    async call(handle, data = {}) {
      const response = await this.$dcsajax({ Controller: 'coremx', handle, data });
      if (response.status !== 100) throw new Error(response.payload?.msg || 'Unable to complete request');
      return response.payload;
    },
    async refresh() {
      this.busy = true;
      this.error = '';
      try {
        this.state = await this.call('list');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async mutate(handle, data) {
      this.busy = true;
      this.error = '';
      this.secret = '';
      try {
        const result = await this.call(handle, data);
        this.secret = result.secret || '';
        this.state = await this.call('list');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    }
  }
};
</script>
