/**
 * Game Wire Schema — schema-first 二進位序列化
 *
 * 「宣告一次，派生四樣」的核心：開發者用 defineComponent 宣告一個 component 的
 * 欄位與型別，即可得到 encode / decode / validate，且 wire 格式緊湊、決定性。
 *
 * 決定性紅線（lockstep 命脈）：
 *   - 所有 peer 必須用「同一份 schema」的同一套 codec 編解碼，位元一致。
 *   - 全部固定 little-endian；欄位順序 = Object.keys(schema) 的插入序（JS 保證穩定）。
 *   - 量化（q8）用 Math.round，跨引擎一致；量化只施加於「輸入」這類本就有限精度的值，
 *     不施加於模擬狀態，避免精度漂移導致 desync。
 *
 * 刻意不做的事：
 *   - 不處理巢狀 component（保持扁平，wire 才可預測）。
 *   - 不自動版本協商（版本由外層 envelope 的 v 欄位負責）。
 */

// ── 二進位讀寫原語 ────────────────────────────────────────────────────────────

/** 可增長的 byte 寫入器（append-only，決定性） */
export class Writer {
  private bytes: number[] = [];
  private readonly scratch = new DataView(new ArrayBuffer(8));

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  u16(v: number): void {
    this.scratch.setUint16(0, v, true);
    this.bytes.push(this.scratch.getUint8(0), this.scratch.getUint8(1));
  }

  u32(v: number): void {
    this.scratch.setUint32(0, v >>> 0, true);
    for (let i = 0; i < 4; i++) this.bytes.push(this.scratch.getUint8(i));
  }

  i8(v: number): void {
    this.scratch.setInt8(0, v);
    this.bytes.push(this.scratch.getUint8(0));
  }

  i16(v: number): void {
    this.scratch.setInt16(0, v, true);
    this.bytes.push(this.scratch.getUint8(0), this.scratch.getUint8(1));
  }

  i32(v: number): void {
    this.scratch.setInt32(0, v, true);
    for (let i = 0; i < 4; i++) this.bytes.push(this.scratch.getUint8(i));
  }

  f32(v: number): void {
    this.scratch.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) this.bytes.push(this.scratch.getUint8(i));
  }

  f64(v: number): void {
    this.scratch.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.bytes.push(this.scratch.getUint8(i));
  }

  /** 無號 LEB128 變長整數（小值省空間，tick/seq/長度用） */
  varint(v: number): void {
    if (v < 0 || !Number.isInteger(v)) throw new RangeError(`varint 需非負整數，得到 ${v}`);
    let n = v;
    while (n >= 0x80) {
      this.bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
  }

  /** UTF-8 字串：varint 長度 + bytes */
  str(v: string): void {
    const enc = new TextEncoder().encode(v);
    this.varint(enc.length);
    for (const b of enc) this.bytes.push(b);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  get length(): number {
    return this.bytes.length;
  }
}

/** byte 讀取器（游標式，配合 Writer 的格式） */
export class Reader {
  private offset = 0;
  constructor(private readonly view: DataView) {}

  u8(): number {
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i8(): number {
    return this.view.getInt8(this.offset++);
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    for (;;) {
      const byte = this.view.getUint8(this.offset++);
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
    }
    return result;
  }

  str(): string {
    const len = this.varint();
    const slice = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return new TextDecoder().decode(slice);
  }

  get consumed(): number {
    return this.offset;
  }
}

// ── Field codec ───────────────────────────────────────────────────────────────

/** 單一欄位的編解碼器。write/read 都對游標式 Writer/Reader 操作。 */
export interface FieldCodec<T> {
  readonly kind: string;
  write(w: Writer, value: T): void;
  read(r: Reader): T;
  validate(v: unknown): v is T;
}

const num = (kind: string, w: (writer: Writer, v: number) => void, r: (reader: Reader) => number): FieldCodec<number> => ({
  kind,
  write: w,
  read: r,
  validate: (v): v is number => typeof v === 'number' && Number.isFinite(v),
});

export const u8: FieldCodec<number> = num('u8', (w, v) => w.u8(v), (r) => r.u8());
export const u16: FieldCodec<number> = num('u16', (w, v) => w.u16(v), (r) => r.u16());
export const u32: FieldCodec<number> = num('u32', (w, v) => w.u32(v), (r) => r.u32());
export const i8: FieldCodec<number> = num('i8', (w, v) => w.i8(v), (r) => r.i8());
export const i16: FieldCodec<number> = num('i16', (w, v) => w.i16(v), (r) => r.i16());
export const i32: FieldCodec<number> = num('i32', (w, v) => w.i32(v), (r) => r.i32());
export const f32: FieldCodec<number> = num('f32', (w, v) => w.f32(v), (r) => r.f32());
export const f64: FieldCodec<number> = num('f64', (w, v) => w.f64(v), (r) => r.f64());
export const varint: FieldCodec<number> = num('varint', (w, v) => w.varint(v), (r) => r.varint());

/** 布林 → 1 byte */
export const bool: FieldCodec<boolean> = {
  kind: 'bool',
  write: (w, v) => w.u8(v ? 1 : 0),
  read: (r) => r.u8() !== 0,
  validate: (v): v is boolean => typeof v === 'boolean',
};

/** UTF-8 字串（varint 長度前綴） */
export const str: FieldCodec<string> = {
  kind: 'str',
  write: (w, v) => w.str(v),
  read: (r) => r.str(),
  validate: (v): v is string => typeof v === 'string',
};

/**
 * 量化浮點 → 1 byte。把 [min,max] 線性映射到 0..255。
 * 精度 = (max-min)/255；適合類比軸、角度等「本就粗略」的輸入。
 * 決定性：Math.round 跨引擎一致。
 */
export function q8(min: number, max: number): FieldCodec<number> {
  const range = max - min;
  if (range <= 0) throw new RangeError('q8 需 max > min');
  return {
    kind: 'q8',
    write(w, v) {
      const clamped = v < min ? min : v > max ? max : v;
      w.u8(Math.round(((clamped - min) / range) * 255));
    },
    read(r) {
      return min + (r.u8() / 255) * range;
    },
    validate: (v): v is number => typeof v === 'number' && Number.isFinite(v),
  };
}

// ── defineComponent ───────────────────────────────────────────────────────────

export type ComponentSchema = Record<string, FieldCodec<unknown>>;

/** 由 schema 反推 component 的資料型別：FieldCodec<T> → T */
export type InferData<S extends ComponentSchema> = {
  [K in keyof S]: S[K] extends FieldCodec<infer T> ? T : never;
};

export interface ComponentDescriptor<S extends ComponentSchema> {
  readonly name: string;
  readonly schema: S;
  readonly fields: readonly (keyof S)[];
  encode(data: InferData<S>): Uint8Array;
  decode(bytes: Uint8Array): InferData<S>;
  validate(data: unknown): data is InferData<S>;
}

/**
 * 宣告一個 component。欄位順序即 schema 物件的鍵插入序（決定性）。
 * 回傳的 descriptor 帶 encode/decode/validate，型別由 schema 自動反推。
 */
export function defineComponent<S extends ComponentSchema>(name: string, schema: S): ComponentDescriptor<S> {
  const fields = Object.keys(schema) as (keyof S)[];

  return {
    name,
    schema,
    fields,
    encode(data) {
      const w = new Writer();
      for (const key of fields) {
        schema[key as string].write(w, (data as Record<string, unknown>)[key as string]);
      }
      return w.finish();
    },
    decode(bytes) {
      const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const out: Record<string, unknown> = {};
      for (const key of fields) {
        out[key as string] = schema[key as string].read(r);
      }
      return out as InferData<S>;
    },
    validate(data): data is InferData<S> {
      if (!data || typeof data !== 'object') return false;
      const o = data as Record<string, unknown>;
      for (const key of fields) {
        if (!schema[key as string].validate(o[key as string])) return false;
      }
      return true;
    },
  };
}

/** 讀取器工廠：從 Uint8Array 建 Reader（給 InputCodec 等外部 codec 用） */
export function readerFrom(bytes: Uint8Array): Reader {
  return new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
