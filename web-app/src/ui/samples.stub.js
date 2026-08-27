// Stands in for the inlined sample corpus in the hosted build, where the sample
// PDFs are served as real files instead.
export function decodeSample(name) {
  throw new Error(`Sample ${name} is served as a file in this build.`);
}
