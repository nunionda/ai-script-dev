import type { ScriptElement, ScriptFormat } from '../../shared/types';

/** 읽기 전용 원고 요소 렌더링 (검토·비교·인쇄 공용) */
export function ScriptLine({ e, className = '', sceneNumber, format }: { e: ScriptElement; className?: string; sceneNumber?: number; format?: ScriptFormat }) {
  return (
    <p className={`el el-${e.type} ${className}`} data-type={e.type} data-scene-number={sceneNumber ? (format === 'korean' ? `S#${sceneNumber}.` : String(sceneNumber)) : undefined}>
      {e.text || ' '}
    </p>
  );
}

export function ScriptView({ elements, format, numberFrom = 1 }: { elements: ScriptElement[]; format: ScriptFormat; numberFrom?: number }) {
  let n = numberFrom - 1;
  return (
    <div className={`script-view format-${format}`}>
      {elements.map((e) => (
        <ScriptLine key={e.id} e={e} format={format} sceneNumber={e.type === 'scene' ? ++n : undefined} />
      ))}
    </div>
  );
}
