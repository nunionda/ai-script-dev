import { useEffect } from 'react';
import { Printer } from 'lucide-react';
import { useProject } from '../state';
import { ScriptView } from '../components/ScriptView';
import { printableElements, sceneLabels } from '../../shared/screenplay';

/** 인쇄 · PDF 저장용 원고. 표지 + 표준 서식 본문. */
export function PrintView() {
  const { project } = useProject();
  useEffect(() => {
    document.title = project.title;
    document.documentElement.classList.add('printing');
    return () => document.documentElement.classList.remove('printing');
  }, [project.title]);

  return (
    <div className={`print-root format-${project.format}`}>
      <div className="print-toolbar">
        <span>
          {project.title} · 인쇄 대화상자에서 “PDF로 저장”을 고르면 PDF 원고가 됩니다. 용지: {project.format === 'korean' ? 'A4' : 'US Letter'}
        </span>
        <button className="primary" onClick={() => window.print()}>
          <Printer aria-hidden="true" />
          인쇄 / PDF 저장
        </button>
      </div>
      <style>{`@page { size: ${project.format === 'korean' ? 'A4' : 'letter'}; }`}</style>
      <section className="title-page">
        <h1>{project.title}</h1>
        {project.author && (
          <p className="byline">
            {project.format === 'korean' ? '각본' : 'Written by'}
            <br />
            {project.author}
          </p>
        )}
        {project.contact && <p className="contact">{project.contact}</p>}
      </section>
      <section className="print-body">
        <ScriptView elements={printableElements(project)} format={project.format} labels={sceneLabels(project)} />
      </section>
    </div>
  );
}
