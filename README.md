# homebridge-philips-dline-sicp

Homebridge plugin to control **Philips D‑Line** signage displays (e.g., **55BDL4511D/00**) over LAN using the **SICP** protocol on **TCP:5000**.  
Exposes the device as a **HomeKit Television** (power + input selection), with optional per‑input **Switches**.

> ⚠️ This plugin is vendor‑unofficial. Keep your display on a trusted VLAN. No auth is implemented by the display on port 5000.

## Features
- Power On/Off (SICP `0x18`).
- Input selection via configurable SICP codes (default HDMI1..4).
- Optional **per‑input switches** for quick Siri/Home automations.
- Multiple displays supported (platform plugin).

## Requirements
- Node.js >= 18.x
- Homebridge >= 1.6.0
- Philips D-Line display with **Network Control over RJ45** enabled (OSD menu), and reachable on the LAN.
- The display should listen on **TCP port 5000** (default for SICP over IP).

## Installation
1. Copy this folder to your Homebridge environment, then:
   ```bash
   cd homebridge-philips-dline-sicp
   npm install
   
   # For local development / manual install:
   sudo npm i -g .
   ```
   *or install from npm once published:*
   ```bash
   sudo npm i -g homebridge-philips-dline-sicp
   ```
2. In Homebridge UI (Config), add the platform and displays as below.

## Configuration
Add to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "PhilipsDLinePlatform",
      "displays": [
        {
          "name": "Salon TV",
          "host": "192.168.1.120",
          "port": 5000,
          "monitorId": 1,
          "includeGroup": true,
          "groupId": 0,
          "pollInterval": 10,
          "exposeInputSwitches": true,
          "inputs": [
            { "label": "HDMI 1", "code": "0x0D", "identifier": 1 },
            { "label": "HDMI 2", "code": "0x06", "identifier": 2 },
            { "label": "HDMI 3", "code": "0x0F", "identifier": 3 },
            { "label": "HDMI 4", "code": "0x19", "identifier": 4 }
          ],
          "exposeBrightness": true
        }
        }
      ]
    }
  ]
}
```

### Notes
- `monitorId`: use the Monitor ID set in the OSD (often 1). `0` means broadcast (typically no reply).
- `includeGroup`: some firmwares expect a *Group* byte; leave `true` unless you see no ACK, then try `false`.
- `inputs`: SICP input codes vary by model/firmware. The defaults work on many D-Line firmwares; adjust if needed.
- `pollInterval`: seconds between lightweight status refresh attempts. Set `0` to disable polling.
- `exposeInputSwitches`: creates a `Switch` per input (mutually exclusive) for simple automations.
- `exposeBrightness`: (Default `true`). Exposes a Lightbulb service for brightness control. **Warning**: If enabled, HomeKit may group this with other lights ("Turn on all lights" -> Turns on TV). Set to `false` if you experience this issue.

## Usage
- Power: Use the Television tile → On/Off.
- Input: Change the **input** from the TV tile, or toggle the per‑input switches (if enabled).
- Siri: “Switch Salon TV to HDMI 2”, “Turn on Salon TV”.

## Troubleshooting
- **No response / timeouts**: check that the display answers on `tcp/5000` (`telnet IP 5000`), and that “Network control / RJ45” is enabled.
- **Input won’t change**: some displays require a short delay after power on; the plugin already waits ~300ms but you can increase it in code if needed.
- **Wrong input codes**: run with debugging, try other codes for `0xAC` (input set). If you have the SICP table for your firmware, copy the exact codes into `inputs`.
- **Security**: do not expose the port to the Internet. Restrict to your LAN/VLAN.

## License
MIT

## Volume & Brightness

You can control **volume** (HomeKit TelevisionSpeaker) and **brightness** (as a Lightbulb service named *Backlight*).  
Because SICP codes may vary by firmware, you can choose between **absolute** and **relative** modes:

### Volume config
```json
"volume": {
  "min": 0,
  "max": 100,
  "initial": 15,
  "setCode": "0x44",          // OPTIONAL: absolute set: [0x44, value 0..100]
  "upCode": "0x45",           // OPTIONAL: relative up:   [0x45]
  "downCode": "0x46",         // OPTIONAL: relative down: [0x46]
  "muteSetCode": "0x47",      // OPTIONAL: absolute mute: [0x47, 0|1]
  "muteToggleCode": "0x48",   // OPTIONAL: toggle mute:   [0x48]
  "stepDelayMs": 120          // delay between relative steps
}
```
> Provide either `setCode` **or** (`upCode` and `downCode`). `muteSetCode` or `muteToggleCode` are optional.

### Brightness config
```json
"brightness": {
  "min": 0,
  "max": 100,
  "initial": 50,
  "setCode": "0x10",          // OPTIONAL: absolute set: [0x10, value 0..100]
  "upCode": "0x11",           // OPTIONAL: relative up:   [0x11]
  "downCode": "0x12",         // OPTIONAL: relative down: [0x12]
  "stepDelayMs": 120
}
```
> If your firmware supports DDC-like absolute brightness, use `setCode` (often `0x32` or `0x10`). Otherwise use relative up/down.
> **Note**: If you do not configure brightness codes, the plugin will attempt a default SICP command (`0x32`) which works on many D-Line models.

### Example full display config
```json
{
  "name": "Salon TV",
  "host": "192.168.1.120",
  "port": 5000,
  "monitorId": 1,
  "includeGroup": true,
  "groupId": 0,
  "pollInterval": 10,
  "exposeInputSwitches": true,
  "inputs": [
    { "label": "HDMI 1", "code": "0x0D", "identifier": 1 },
    { "label": "HDMI 2", "code": "0x06", "identifier": 2 },
    { "label": "HDMI 3", "code": "0x0F", "identifier": 3 },
    { "label": "HDMI 4", "code": "0x19", "identifier": 4 }
  ],
  "volume": {
    "min": 0,
    "max": 60,
    "initial": 10,
    "setCode": "0x44",
    "muteSetCode": "0x47"
  },
  "brightness": {
    "min": 0,
    "max": 100,
    "initial": 50,
    "setCode": "0x10"
  }
}
```


## If it still shows as a switch
- The plugin now explicitly sets the Accessory Category to `TELEVISION`.
- If the icon remains a box/switch, try restarting Homebridge or removing/re-adding the accessory (or clearing `cachedAccessories`).
