/** Browser-side resume text extraction (PDF via pdfjs-dist, DOCX via jszip). */

/** Below this many characters the file is almost certainly a scan with no text layer. */
export const MIN_RESUME_CHARS = 200;

export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksScanned(text: string) {
  return text.trim().length < MIN_RESUME_CHARS;
}

export async function extractResumeText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || file.type === "text/plain") return (await file.text()).trim();
  if (name.endsWith(".docx")) {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const doc = zip.file("word/document.xml");
    if (!doc) throw new Error("This .docx has no document body.");
    return docxXmlToText(await doc.async("string"));
  }
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join(""));
    }
    return pages.join("\n").replace(/[ \t]+\n/g, "\n").trim();
  }
  throw new Error("Upload a .pdf, .docx or .txt file.");
}
