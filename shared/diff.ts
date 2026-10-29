import type { ScriptElement } from './types';

export type DiffOp =
  | { kind: 'same'; a: ScriptElement; b: ScriptElement }
  | { kind: 'del'; a: ScriptElement }
  | { kind: 'add'; b: ScriptElement }
  | { kind: 'change'; a: ScriptElement; b: ScriptElement };

const key = (e: ScriptElement) => `${e.type}\u0000${e.text.trim()}`;

/** 요소 단위 LCS 차이. 같은 종류의 삭제·추가가 붙어 있으면 'change'로 묶는다. */
export function diffElements(a: ScriptElement[], b: ScriptElement[]): DiffOp[] {
  // 앞뒤 공통 부분은 LCS 표에서 제외 (긴 원고 비교를 가볍게)
  let pre = 0;
  while (pre < a.length && pre < b.length && key(a[pre]) === key(b[pre])) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && key(a[a.length - 1 - suf]) === key(b[b.length - 1 - suf])) suf++;
  const head: DiffOp[] = a.slice(0, pre).map((x, i) => ({ kind: 'same', a: x, b: b[i] }));
  const tail: DiffOp[] = a.slice(a.length - suf).map((x, i) => ({ kind: 'same', a: x, b: b[b.length - suf + i] }));
  return [...head, ...diffCore(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)), ...tail];
}

function diffCore(a: ScriptElement[], b: ScriptElement[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ka = a.map(key);
  const kb = b.map(key);
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      raw.push({ kind: 'same', a: a[i++], b: b[j++] });
    } else if (dp[i + 1][j] >= dp[i][j + 1]) raw.push({ kind: 'del', a: a[i++] });
    else raw.push({ kind: 'add', b: b[j++] });
  }
  while (i < n) raw.push({ kind: 'del', a: a[i++] });
  while (j < m) raw.push({ kind: 'add', b: b[j++] });

  // 연속된 del/add 구간에서 같은 종류끼리 짝지어 change로 만든다
  const out: DiffOp[] = [];
  let k = 0;
  while (k < raw.length) {
    if (raw[k].kind === 'same') {
      out.push(raw[k++]);
      continue;
    }
    const dels: ScriptElement[] = [];
    const adds: ScriptElement[] = [];
    while (k < raw.length && raw[k].kind !== 'same') {
      const op = raw[k++];
      if (op.kind === 'del') dels.push(op.a);
      else if (op.kind === 'add') adds.push(op.b);
    }
    let di = 0;
    let ai = 0;
    while (di < dels.length || ai < adds.length) {
      const d = dels[di];
      const ad = adds[ai];
      if (d && ad && d.type === ad.type) {
        out.push({ kind: 'change', a: d, b: ad });
        di++;
        ai++;
      } else if (d && (!ad || dels.length - di >= adds.length - ai)) {
        out.push({ kind: 'del', a: d });
        di++;
      } else {
        out.push({ kind: 'add', b: ad! });
        ai++;
      }
    }
  }
  return out;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
}

export function summarizeDiff(ops: DiffOp[]): DiffSummary {
  const s = { added: 0, removed: 0, changed: 0 };
  for (const op of ops) {
    if (op.kind === 'add') s.added++;
    else if (op.kind === 'del') s.removed++;
    else if (op.kind === 'change') s.changed++;
  }
  return s;
}
