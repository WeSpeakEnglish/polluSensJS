/** pollusens.js - browser-compatible version with built-in connect/disconnect and UI helpers **/
(function(global) {
  function parseByteValue(v) {
    return typeof v === 'string' && v.startsWith('0x') ? parseInt(v, 16) : v;
  }

  function parseByteField(field) {
    if (field === "none") return field;
    if (Array.isArray(field)) return field.map(parseByteValue);
    return parseByteValue(field);
  }

  function evalSafe(expr, context) {
    return Function(...Object.keys(context), `return (${expr})`)(...Object.values(context));
  }

  function getDefaultConfigUrl() {
    const script = document.currentScript?.src || '';
    const basePath = script.substring(0, script.lastIndexOf('/') + 1);
    return basePath + 'sensors.json';
  }

  class PolluSens {
    constructor(config) {
      this.config = config;
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.buffer = [];
      this.commandInterval = null;
      this.readQueue = [];
      this.onData = null;
      this.onError = null;
      this.onRawFrame = null;
    }

    static async listSensorNames(url = null) {
      if (!url) url = getDefaultConfigUrl();
      const res = await fetch(url);
      const json = await res.json();
      const rawSensors = Array.isArray(json.sensors) ? json.sensors : [json];
      return rawSensors.map(s => s.name).filter(Boolean);
    }

    static async loadConfig(url = null, sensorName = null) {
      if (!url) url = getDefaultConfigUrl();
      const res = await fetch(url);
      const json = await res.json();
      const rawSensors = Array.isArray(json.sensors) ? json.sensors : [json];

      const nameMap = {};
      rawSensors.forEach(s => { if (s.name) nameMap[s.name] = s; });

      function resolveInheritance(sensor, stack = []) {
        if (!sensor || typeof sensor !== 'object' || !sensor.name) return null;
        if (!sensor.inherits_from) return sensor;
        if (stack.includes(sensor.name)) {
          console.warn("Circular inheritance:", [...stack, sensor.name].join(" -> "));
          return sensor;
        }

        const base = nameMap[sensor.inherits_from];
        if (!base) {
          console.warn("Base sensor not found:", sensor.inherits_from);
          return sensor;
        }

        const resolvedBase = resolveInheritance(base, [...stack, sensor.name]);
        return {
          name: sensor.name,
          command: sensor.command ?? resolvedBase.command,
          send_cmd_period: sensor.send_cmd_period ?? resolvedBase.send_cmd_period,
          port: { ...resolvedBase.port, ...(sensor.port || {}) },
          frame: { ...resolvedBase.frame, ...(sensor.frame || {}) },
          checksum: { ...resolvedBase.checksum, ...(sensor.checksum || {}) },
          data: { ...resolvedBase.data, ...(sensor.data || {}) }
        };
      }

      const sensors = rawSensors.map(resolveInheritance).filter(Boolean);

      if (sensorName) {
        const match = sensors.find(s => s.name === sensorName);
        if (!match) throw new Error(`Sensor '${sensorName}' not found in configuration`);
        return [match];
      }

      return sensors;
    }

    static async connectByName(sensorName, url = null) {
      const [config] = await this.loadConfig(url, sensorName);
      const instance = new PolluSens(config);
      await instance.connect();
      return instance;
    }

    static async disconnectAndCleanup(instance) {
      if (!instance || !(instance instanceof PolluSens)) return;
      await instance.disconnect();
      instance.onData = null;
      instance.onRawFrame = null;
      instance.onError = null;
      instance.readQueue = [];
      instance.buffer = [];
    }

    static async init({ sensorSelect, debugOutput }) {
      this._ui = {
        sensorSelect: document.querySelector(sensorSelect),
        debugOutput: document.querySelector(debugOutput)
      };
      this._serial = null;

      const names = await this.listSensorNames();
      this._ui.sensorSelect.innerHTML = names.map(name => `<option value="${name}">${name}</option>`).join('');
    }

    static _append(msg) {
      const area = this._ui.debugOutput;
      area.value += msg + '\n';
      area.scrollTop = area.scrollHeight;
    }

    static async connect() {
      const name = this._ui.sensorSelect.value;
      try {
        this._serial = await this.connectByName(name);
        this._append(`[Connected to ${name}]`);

        this._serial.onData = parsed => {
          const ts = new Date().toLocaleTimeString();
          this._append(`[Parsed @ ${ts}]`);
          for (const [k, v] of Object.entries(parsed)) {
            this._append(`  ${k}: ${v}`);
          }
        };

        this._serial.onRawFrame = raw => {
          const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join(' ');
          this._append(`Raw: ${hex}`);
        };

        this._serial.onError = msg => this._append(`[Error] ${msg}`);

      } catch (e) {
        this._append(`[Failed to connect] ${e.message}`);
      }
    }

    static async disconnect() {
      if (this._serial) {
        await this.disconnectAndCleanup(this._serial);
        this._serial = null;
        this._append(`[Disconnected]`);
      }
    }

    async connect() {
      this.port = await navigator.serial.requestPort();
      await this.port.open(this.config.port);
      this.reader = this.port.readable.getReader();

      if (!this.onData) {
        this.onData = (parsed) => {
          console.log("[Parsed]");
          for (const [k, v] of Object.entries(parsed)) {
            console.log(`  ${k}: ${v}`);
          }
        };
      }

      if (!this.onRawFrame) {
        this.onRawFrame = (data) => {
          const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.log("Raw:", hex);
        };
      }

      if (!this.onError) {
        this.onError = (msg) => console.error("[Error]", msg);
      }

      this.startReadLoop();
      await this.sendCommandIfNeeded();
    }

    async disconnect() {
      if (this.commandInterval) {
        clearInterval(this.commandInterval);
        this.commandInterval = null;
      }

      if (this.reader) {
        try {
          await this.reader.cancel();
          this.reader.releaseLock();
        } catch (e) {}
        this.reader = null;
      }

      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    }

    async sendCommandIfNeeded() {
      const cmd = this.config.command;
      const period = this.config.send_cmd_period;

      if (!cmd || cmd.toLowerCase() === "none") return;

      const bytes = cmd.split(/\s+/).map(hex => parseInt(hex, 16));
      const data = new Uint8Array(bytes);

      const sendOnce = async () => {
        try {
          this.writer = this.port.writable.getWriter();
          await this.writer.write(data);
          this.writer.releaseLock();
        } catch (e) {
          this.writer = null;
          this.handleError("Error sending command: " + e.message);
        }
      };

      await sendOnce();

      if (typeof period === "number" && period > 0) {
        this.commandInterval = setInterval(sendOnce, period * 1000);
      }
    }

    startReadLoop() {
      const { frame, checksum, data: dataFields } = this.config;
      const useStart = frame.startByte !== "none";
      const useEnd = frame.endByte !== "none";
      const frameLength = frame.length;
      const startByte = parseByteField(frame.startByte);
      const endByte = parseByteField(frame.endByte);

      const handleFrame = (data) => {
        const valid = evalSafe(checksum.eval, { data }) === evalSafe(checksum.compare, { data });

        if (valid) {
          if (typeof this.onRawFrame === 'function') {
            this.onRawFrame(new Uint8Array(data));
          }

          const parsed = {};
          for (const [name, meta] of Object.entries(dataFields)) {
            const expr = typeof meta === 'object' ? meta.value : meta;
            parsed[name] = evalSafe(expr, { data });
          }

          if (this.readQueue.length > 0) {
            const resolve = this.readQueue.shift();
            resolve(parsed);
          }

          if (typeof this.onData === 'function') {
            this.onData(parsed);
          }

          return true;
        }

        return false;
      };

      const loop = async () => {
        try {
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) break;
            this.buffer.push(...value);

            while (this.buffer.length >= frameLength) {
              const slice = this.buffer.slice(0, frameLength);

              const matchesStart = Array.isArray(startByte)
                ? startByte.every((v, i) => slice[i] === v)
                : !useStart || slice[0] === startByte;

              const matchesEnd = !useEnd || (
                Array.isArray(endByte)
                  ? endByte.every((v, i) => slice[frameLength - endByte.length + i] === v)
                  : slice[frameLength - 1] === endByte
              );

              if (matchesStart && matchesEnd) {
                const data = slice;
                this.buffer = this.buffer.slice(frameLength);

                if (!handleFrame(data)) {
                  this.handleError("Checksum failed");
                }
              } else {
                this.buffer.shift();
              }
            }
          }
        } catch (e) {
          this.handleError("Read loop error: " + e.message);
        }
      };

      loop();
    }

    handleError(msg) {
      console.error(msg);
      if (typeof this.onError === 'function') {
        this.onError(msg);
      }
    }
  }

  global.PolluSens = PolluSens;
})(window);



