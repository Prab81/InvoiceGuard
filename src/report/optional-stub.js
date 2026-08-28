// jsPDF lazily references html2canvas, canvg and dompurify for its HTML-capture
// path. This report is typeset directly, so those never run - aliasing them to
// this stub keeps ~400 kB of unused rasteriser out of the bundle.
export default undefined;
