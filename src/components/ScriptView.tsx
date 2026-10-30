import type { ScriptElement, ScriptFormat } from '../../shared/types';

/** 읽기 전용 원고 요소 렌더링 (검토·비교·인쇄 공용) */
export function ScriptLine({ e, className = '', sceneLabel, format }: { e: ScriptElement; className?: string; sceneLabel?: string; format?: ScriptFormat }) {
  return (
    <p className={`el el-${e.type} ${className}`} data-type={e.type} data-scene-number={sceneLabel ? (format === 'korean' ? `S#${sceneLabel}.` : sceneLabel) : undefined}>
      {e.text || ' '}
    </p>
  );
}

/** labels가 없으면 장면 번호를 1부터 매긴다. */
export function ScriptView({ elements, format, labels }: { elements: ScriptElement[]; format: ScriptFormat; labels?: Map<string, string> }) {
  let n = 0;
  return (
    <div className={`script-view format-${format}`}>
      {elements.map((e) => (
        <ScriptLine key={e.id} e={e} format={format} sceneLabel={e.type === 'scene' ? (labels?.get(e.id) ?? String(++n)) : undefined} />
      ))}
    </div>
  );
}
