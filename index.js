'use strict';

/**
 * Homebridge plugin to control Philips D-Line signage displays (e.g., 55BDL4511D/00)
 * over LAN using SICP over TCP (default port 5000).
 *
 * Exposes a HomeKit Television with inputs, volume (TelevisionSpeaker), and brightness (as a Lightbulb service).
 */

const net = require('net');
let hap;

const PLUGIN_NAME = 'homebridge-philips-dline-sicp';
const PLATFORM_NAME = 'PhilipsDLinePlatform';

/** Simple promise-based sleep */
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

/** Clamp helper */
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

/** A light-weight send queue so we don't overlap TCP writes */
class SendQueue {
  constructor(sender) {
    this.sender = sender; // async (buf) => Buffer
    this.queue = Promise.resolve();
  }
  send(buf) {
    const job = async () => {
      try {
        return await this.sender(buf);
      } catch (e) {
        throw e;
      }
    };
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => { });
    return p;
  }
}

/** Build a SICP packet */
function buildSicpPacket(monitorId, dataBytes, includeGroup = true, groupId = 0x00) {
  const body = includeGroup ? [monitorId & 0xFF, groupId & 0xFF, ...dataBytes] : [monitorId & 0xFF, ...dataBytes];
  const msgSize = 1 + body.length + 1; // size + body + checksum
  const arr = [msgSize & 0xFF, ...body];
  let checksum = 0x00;
  for (const b of arr) checksum ^= (b & 0xFF);
  arr.push(checksum & 0xFF);
  return Buffer.from(arr);
}

/** Parse a basic ACK/NACK/NAV (best-effort) */
function parseReply(buf) {
  const bytes = [...buf];
  return {
    raw: bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
    ok: bytes.includes(0x06),
    nack: bytes.includes(0x15),
    nav: bytes.includes(0x18),
  };
}

/** TCP client for SICP */
class SicpClient {
  constructor(host, port = 5000, timeoutMs = 1200) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.queue = new SendQueue(this._sendOnce.bind(this));
  }

  async send(pkt) {
    return this.queue.send(pkt);
  }

  _sendOnce(pkt) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let chunks = [];
      let done = false;

      const finish = (err, data) => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch { }
        if (err) reject(err);
        else resolve(Buffer.concat(data || []));
      };

      socket.setTimeout(this.timeoutMs, () => finish(new Error('SICP: timeout'), chunks));
      socket.once('error', (e) => finish(e, chunks));
      socket.connect(this.port, this.host, () => {
        socket.write(pkt);
      });
      socket.on('data', (d) => chunks.push(Buffer.from(d)));
      socket.once('close', () => finish(null, chunks));
      // Some firmwares keep the socket open; close after a short delay
      setTimeout(() => { try { socket.end(); } catch { } }, 200);
    });
  }
}

/** Accessory representing one D-Line TV */
class PhilipsDLineTelevisionAccessory {
  constructor(platform, accessory, conf) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.name = conf.name || 'Philips D-Line';
    this.host = conf.host;
    this.port = conf.port || 5000;
    this.monitorId = (conf.monitorId === 0 || conf.monitorId) ? conf.monitorId : 1;
    this.includeGroup = conf.includeGroup !== false; // default true
    this.groupId = conf.groupId || 0x00;
    this.pollInterval = conf.pollInterval || 10; // seconds
    this.exposeBrightness = conf.exposeBrightness !== false; // default true

    // Inputs config
    this.inputs = Array.isArray(conf.inputs) && conf.inputs.length ? conf.inputs : [
      { label: 'HDMI 1', code: '0x0D', identifier: 1 },
      { label: 'HDMI 2', code: '0x06', identifier: 2 },
      { label: 'HDMI 3', code: '0x0F', identifier: 3 },
      { label: 'HDMI 4', code: '0x19', identifier: 4 },
    ];
    this.exposeInputSwitches = !!conf.exposeInputSwitches;

    // Volume config (two modes: absolute set, or relative up/down repeat)
    this.volume = {
      min: conf.volume?.min ?? 0,
      max: conf.volume?.max ?? 100,
      // Absolute set: send [volSetCode, value] if provided
      setCode: conf.volume?.setCode, // e.g. "0x44"
      // Relative: send [volUpCode] or [volDownCode] N times
      upCode: conf.volume?.upCode,
      downCode: conf.volume?.downCode,
      // Mute support
      muteSetCode: conf.volume?.muteSetCode, // absolute mute set [code, 0/1]
      muteToggleCode: conf.volume?.muteToggleCode, // single code to toggle
      // UI state
      current: clamp(conf.volume?.initial ?? 15, conf.volume?.min ?? 0, conf.volume?.max ?? 100),
      muted: false,
      stepMs: conf.volume?.stepDelayMs ?? 120, // delay between relative steps
    };

    // Brightness config (absolute preferred; fallback relative)
    this.brightness = {
      min: conf.brightness?.min ?? 0,
      max: conf.brightness?.max ?? 100,
      setCode: conf.brightness?.setCode,      // e.g. "0x10"
      upCode: conf.brightness?.upCode,
      downCode: conf.brightness?.downCode,
      current: clamp(conf.brightness?.initial ?? 50, conf.brightness?.min ?? 0, conf.brightness?.max ?? 100),
      stepMs: conf.brightness?.stepDelayMs ?? 120,
    };

    // State
    this.active = 0; // 0=INACTIVE, 1=ACTIVE
    this.activeIdentifier = this.inputs[0]?.identifier ?? 1;

    this.client = new SicpClient(this.host, this.port);
    this._setupServices();
    this._startPolling();
  }

  _setupServices() {
    const Service = hap.Service;
    const Characteristic = hap.Characteristic;

    this.televisionService = this.accessory.getService(Service.Television)
      || this.accessory.addService(Service.Television, this.name);

    this.televisionService
      .setCharacteristic(Characteristic.ConfiguredName, this.name)
      .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    // Power
    this.televisionService.getCharacteristic(Characteristic.Active)
      .onGet(this.handleGetActive.bind(this))
      .onSet(this.handleSetActive.bind(this));

    // Active input
    this.televisionService.getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(async () => this.activeIdentifier)
      .onSet(this.handleSetActiveIdentifier.bind(this));

    // Add inputs as InputSource services
    this.inputs.forEach((inp, idx) => {
      const id = (typeof inp.identifier === 'number') ? inp.identifier : (idx + 1);
      const label = inp.label || `Input ${id}`;

      let inputService = this.accessory.getService(label);
      if (!inputService) {
        inputService = this.accessory.addService(Service.InputSource, label, 'input-' + id);
      }
      inputService
        .setCharacteristic(Characteristic.Identifier, id)
        .setCharacteristic(Characteristic.ConfiguredName, label)
        .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);

      this.televisionService.addLinkedService(inputService);
    });

    // Optional: expose input switches
    if (this.exposeInputSwitches) {
      this.inputs.forEach((inp, idx) => {
        const id = (typeof inp.identifier === 'number') ? inp.identifier : (idx + 1);
        const label = `${inp.label || `Input ${id}`} Switch`;
        const s = this.accessory.addService(Service.Switch, label, 'switch-' + id);
        s.getCharacteristic(Characteristic.On)
          .onGet(async () => this.active && (this.activeIdentifier === id))
          .onSet(async (val) => {
            if (val) {
              await this._ensureOn();
              await this._setInputByIdentifier(id);
              // Turn off other input switches
              this.inputs.forEach((other, j) => {
                const oid = (typeof other.identifier === 'number') ? other.identifier : (j + 1);
                if (oid !== id) {
                  const os = this.accessory.getService(`${other.label || `Input ${oid}`} Switch`);
                  if (os) os.updateCharacteristic(Characteristic.On, false);
                }
              });
            } else {
              // no-op
            }
          });
      });
    }

    // --- TelevisionSpeaker (volume & mute) ---
    this.speakerService = this.accessory.getService(Service.TelevisionSpeaker)
      || this.accessory.addService(Service.TelevisionSpeaker);

    this.speakerService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE); // we emulate absolute

    this.speakerService.getCharacteristic(Characteristic.Mute)
      .onGet(async () => this.volume.muted)
      .onSet(this.handleSetMute.bind(this));

    this.speakerService.getCharacteristic(Characteristic.Volume)
      .onGet(async () => this.volume.current)
      .onSet(this.handleSetVolume.bind(this));

    // Link speaker to TV
    this.televisionService.addLinkedService(this.speakerService);

    // --- Brightness as a Lightbulb service ---
    if (this.exposeBrightness) {
      this.backlightService = this.accessory.getService('Backlight')
        || this.accessory.addService(Service.Lightbulb, 'Backlight', 'backlight');

      this.backlightService.getCharacteristic(Characteristic.On)
        .onGet(async () => this.active === 1 && this.brightness.current > this.brightness.min)
        .onSet(async (val) => {
          if (val) {
            // If TV is OFF, do NOT turn it on automatically just because "All lights" were turned on.
            if (this.active !== 1) {
              this.log.info('Ignoring Backlight On request because TV is OFF.');
              // We can throw an error to indicate failure, or just revert the state.
              // Throwing an error might be annoying in scenes, but reverting is cleaner.
              setTimeout(() => {
                this.backlightService.updateCharacteristic(Characteristic.On, false);
              }, 100);
              return;
            }
            if (this.brightness.current <= this.brightness.min) {
              await this._setBrightness(Math.max(this.brightness.min + 1, 10));
            }
          } else {
            // Turning off backlight -> set brightness to min
            await this._setBrightness(this.brightness.min);
          }
        });

      this.backlightService.getCharacteristic(Characteristic.Brightness)
        .onGet(async () => this.brightness.current)
        .onSet(async (val) => {
          // If TV is OFF, ignore brightness set
          if (this.active !== 1) {
            this.log.info('Ignoring Brightness Set request because TV is OFF.');
            return;
          }
          await this._setBrightness(val);
        });
    } else {
      // Remove service if it exists (e.g. if user disabled it)
      const existing = this.accessory.getService('Backlight');
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Publish Accessory information
    const info = this.accessory.getService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Philips (Signage)')
      .setCharacteristic(Characteristic.Model, 'D-Line (SICP over IP)')
      .setCharacteristic(Characteristic.SerialNumber, this.host);
  }

  // ---------------- Handlers ----------------

  async handleGetActive() {
    try {
      const pkt = buildSicpPacket(this.monitorId, [0x19], this.includeGroup, this.groupId); // Get Power
      const reply = await this.client.send(pkt);
      const parsed = parseReply(reply);
      // parsed.raw is e.g. "0x06 0x02" where 0x02 is ON.
      this.platform.log.debug('GetActive reply:', parsed.raw);

      // SICP Get Power Reply: [Len, Mon, Grp, ACK(06), Status] or just [ACK, Status] depending on model.
      // We need to actually parse the status byte.
      // Assuming the last byte before checksum or the byte after 0x06 is status.
      // Let's look for 0x02 (On) or 0x01 (Standby) in the reply.
      const bytes = [...reply];
      // Simple heuristic: if it contains 0x02, it's ON. If 0x01, it's OFF.
      // Note: This matches the Set Power command (0x02=On, 0x01=Off).
      if (bytes.includes(0x02)) {
        this.active = 1;
      } else if (bytes.includes(0x01)) {
        this.active = 0;
      }
      // If we got a reply but couldn't check status, we validly connected at least. 
      // But typically we should trust the parsed status.

      return this.active;
    } catch (e) {
      this.log.warn('GetActive failed (TV unreachable?):', e.message);
      this.active = 0; // Assume OFF if unreachable
      return this.active;
    }
  }

  async handleSetActive(value) {
    const on = (value === 1 || value === true);
    try {
      const pkt = buildSicpPacket(this.monitorId, [0x18, on ? 0x02 : 0x01], this.includeGroup, this.groupId); // Set Power
      const reply = await this.client.send(pkt);
      const parsed = parseReply(reply);
      this.log.debug('SetActive reply:', parsed.raw);
      if (parsed.nack || parsed.nav) throw new Error('Device rejected command');
      this.active = on ? 1 : 0;
      if (!on && this.exposeInputSwitches) {
        this.inputs.forEach((inp, idx) => {
          const id = (typeof inp.identifier === 'number') ? inp.identifier : (idx + 1);
          const s = this.accessory.getService(`${inp.label || `Input ${id}`} Switch`);
          if (s) s.updateCharacteristic(hap.Characteristic.On, false);
        });
      }
    } catch (e) {
      this.log.error('SetActive error:', e.message);
      this.televisionService.updateCharacteristic(hap.Characteristic.Active, this.active);
      throw e;
    }
  }

  async handleSetActiveIdentifier(identifier) {
    await this._ensureOn();
    await this._setInputByIdentifier(identifier);
  }

  async handleSetVolume(val) {
    const target = clamp(Number(val), this.volume.min, this.volume.max);
    await this._ensureOn();
    if (this.volume.setCode) {
      // Absolute mode
      const code = this._parseCode(this.volume.setCode);
      if (code === 0x44) {
        // SICP Volume Set: [0x44, SpeakerVol, AudioOutVol]; use 0xFF (no change) for Audio Out
        await this._send([code, target & 0xFF, 0xFF]);
      } else {
        await this._send([code, target & 0xFF]);
      }
    } else if (this.volume.upCode && this.volume.downCode) {
      // Relative mode: step towards target
      const diff = target - this.volume.current;
      const stepCode = diff > 0 ? this._parseCode(this.volume.upCode) : this._parseCode(this.volume.downCode);
      for (let i = 0; i < Math.abs(diff); i++) {
        await this._send([stepCode]);
        await delay(this.volume.stepMs);
      }
    } else {
      this.log.warn('Volume codes not configured; ignoring setVolume.');
    }
    this.volume.current = target;
    this.speakerService.updateCharacteristic(hap.Characteristic.Volume, this.volume.current);
  }

  async handleSetMute(val) {
    const mute = !!val;
    await this._ensureOn();
    if (this.volume.muteSetCode) {
      const code = this._parseCode(this.volume.muteSetCode);
      await this._send([code, mute ? 0x01 : 0x00]);
    } else if (this.volume.muteToggleCode) {
      const code = this._parseCode(this.volume.muteToggleCode);
      // If desired state differs, send one toggle
      if (mute !== this.volume.muted) {
        await this._send([code]);
      }
    } else {
      this.log.warn('Mute codes not configured; ignoring mute.');
    }
    this.volume.muted = mute;
    this.speakerService.updateCharacteristic(hap.Characteristic.Mute, this.volume.muted);
  }

  // ---------------- Helpers ----------------

  async _ensureOn() {
    if (this.active !== 1) {
      await this.handleSetActive(1);
      await delay(300);
    }
  }

  _codeFromIdentifier(identifier) {
    const inp = this.inputs.find(x => (x.identifier === identifier));
    if (!inp) return null;
    const raw = (typeof inp.code === 'string') ? inp.code : inp.code?.toString();
    if (!raw) return null;
    const code = raw.trim().toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
    if (Number.isNaN(code)) return null;
    return code & 0xFF;
  }

  _parseCode(raw) {
    if (typeof raw === 'number') return raw & 0xFF;
    const s = String(raw).trim().toLowerCase();
    return (s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10)) & 0xFF;
  }

  async _setInputByIdentifier(identifier) {
    const code = this._codeFromIdentifier(identifier);
    if (code == null) {
      this.log.error('Unknown input identifier:', identifier);
      return;
    }
    const reply = await this._send([0xAC, code]); // Set Input
    const parsed = parseReply(reply);
    this.log.debug(`SetInput(${identifier}/0x${code.toString(16)}) reply:`, parsed.raw);
    if (parsed.nack || parsed.nav) throw new Error('Device rejected input change');
    this.activeIdentifier = identifier;
    this.televisionService.updateCharacteristic(hap.Characteristic.ActiveIdentifier, identifier);
    if (this.exposeInputSwitches) {
      this.inputs.forEach((inp, idx) => {
        const id = (typeof inp.identifier === 'number') ? inp.identifier : (idx + 1);
        const s = this.accessory.getService(`${inp.label || `Input ${id}`} Switch`);
        if (s) s.updateCharacteristic(hap.Characteristic.On, id === identifier);
      });
    }
  }

  async _setBrightness(val) {
    const target = clamp(Number(val), this.brightness.min, this.brightness.max);
    if (this.brightness.setCode) {
      const code = this._parseCode(this.brightness.setCode);
      if (code === 0x32) {
        // SICP Video Parameters Set: [0x32, Brightness, Color, Contrast, Sharpness, Tint, BlackLevel, Gamma]
        // Use 0xFF for "no change" on other fields (supported since SICP 2.09)
        await this._send([code, target & 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
      } else {
        await this._send([code, target & 0xFF]);
      }
    } else if (this.brightness.upCode && this.brightness.downCode) {
      const diff = target - this.brightness.current;
      const stepCode = diff > 0 ? this._parseCode(this.brightness.upCode) : this._parseCode(this.brightness.downCode);
      for (let i = 0; i < Math.abs(diff); i++) {
        await this._send([stepCode]);
        await delay(this.brightness.stepMs);
      }
    } else {
      // Fallback: If no brightness setCode or up/down codes, try default 0x32 (Video Parameters)
      // Many D-Lines support 0x32 for brightness.
      this.log.debug('No brightness codes configured, attempting default SICP 0x32 command.');
      try {
        // [0x32, Brightness, Color, Contrast, Sharpness, Tint, BlackLevel, Gamma]
        // We'll try just sending [0x32, val]. Some older SICP might accept just valid params.
        // Or better, use the full safe string:
        // await this._send([0x32, target & 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        // Wait, the code existed but was inside 'if (this.brightness.setCode)'.
        // Let's force try 0x32 if nothing else is set.
        await this._send([0x32, target & 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
      } catch (e) {
        this.log.warn('Default brightness 0x32 failed:', e.message);
      }
    }
    this.brightness.current = target;
    if (this.exposeBrightness) {
      this.backlightService.updateCharacteristic(hap.Characteristic.Brightness, this.brightness.current);
      this.backlightService.updateCharacteristic(hap.Characteristic.On, this.brightness.current > this.brightness.min);
    }
  }

  async _send(dataBytes) {
    const pkt = buildSicpPacket(this.monitorId, dataBytes, this.includeGroup, this.groupId);
    const reply = await this.client.send(pkt);
    return reply;
  }

  _startPolling() {
    if (!this.pollInterval || this.pollInterval <= 0) return;
    const loop = async () => {
      try {
        await delay(this.pollInterval * 1000);
        await this.handleGetActive().catch(() => { });
      } catch (e) {
        // ignore
      } finally {
        setImmediate(loop);
      }
    };
    loop();
  }
}

/** Platform (supports multiple displays) */
class PhilipsDLinePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    hap = api.hap;

    this.accessories = new Map(); // UUID -> accessory

    if (!this.config.displays || !Array.isArray(this.config.displays) || this.config.displays.length === 0) {
      this.log.warn('No "displays" configured. Please add at least one display.');
    }

    api.on('didFinishLaunching', () => {
      this.discover();
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  discover() {
    const displays = this.config.displays || [];
    displays.forEach(conf => {
      if (!conf || !conf.host) {
        this.log.warn('Skipping display without "host" field:', conf);
        return;
      }
      const uuid = this.api.hap.uuid.generate(`philips-dline:${conf.host}:${conf.name || ''}`);
      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(conf.name || 'Philips D-Line', uuid);
        accessory.context.conf = conf;
        // Fix for icon issue: Set category to TELEVISION
        accessory.category = this.api.hap.Categories.TELEVISION;

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info('Registered new display accessory:', conf.name || conf.host);
      } else {
        accessory.context.conf = conf;
        // Ensure category is updated if it was missing
        accessory.category = this.api.hap.Categories.TELEVISION;
        this.log.info('Updated display accessory:', conf.name || conf.host);
      }
      new PhilipsDLineTelevisionAccessory(this, accessory, conf);
    });
  }
}

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, PhilipsDLinePlatform);
};
