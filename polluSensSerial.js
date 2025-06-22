
// polluSensSerial.js
export class PolluSensSerial {
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
  }

  static async loadConfig(url = null, sensorName = null) {
    if (!url) {
      const scriptUrl = import.meta.url;
      const basePath = scriptUrl.substring(0, scriptUrl.lastIndexOf('/') + 1);
      url = basePath + 'sensors.json';
    }

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

  async connect() {
    this.port = await navigator.serial.requestPort();
    await this.port.open(this.config.port);
    this.reader = this.port.readable.getReader();
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

  async readNext() {
    return new Promise((resolve, reject) => {
      this.readQueue.push(resolve);
    });
  }

  startReadLoop() {
    const { frame, checksum, data: dataFields } = this.config;
    const useStart = frame.startByte !== "none";
    const useEnd = frame.endByte !== "none";
    const frameLength = frame.length;
    const startByte = this.parseByteField(frame.startByte);
    const endByte = this.parseByteField(frame.endByte);

    const evalSafe = (expr, context) => Function(...Object.keys(context), `return (${expr})`)
      (...Object.values(context));

    const handleFrame = (data) => {
      const valid = evalSafe(checksum.eval, { data }) === evalSafe(checksum.compare, { data });

      if (valid) {
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

  parseByteField(field) {
    if (field === "none") return field;
    if (Array.isArray(field)) return field.map(this.parseByteValue);
    return this.parseByteValue(field);
  }

  parseByteValue(v) {
    return typeof v === 'string' && v.startsWith('0x') ? parseInt(v, 16) : v;
  }
}
