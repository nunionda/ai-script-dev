import { pdfTextToParagraphs, type Paragraph, type PdfPage } from '../shared/importers';

/** PDF의 글자 조각과 위치를 뽑아 문단으로 묶는다. 글자가 없는 스캔본은 읽을 수 없다. */
export async function pdfParagraphs(data: Uint8Array): Promise<Paragraph[]> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push({
      height: page.getViewport({ scale: 1 }).height,
      width: page.getViewport({ scale: 1 }).width,
      items: content.items.flatMap((i) =>
        'str' in i && i.str.trim() ? [{ text: i.str, x: i.transform[4], y: i.transform[5], w: i.width, size: Math.abs(i.transform[3]) || i.height || 10 }] : [],
      ),
    });
  }
  return pdfTextToParagraphs(pages);
}
