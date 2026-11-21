/**
 * GitHub Actions workflow command annotations.
 * See https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
 */

export interface GithubAnnotation {
  kind: "error" | "warning" | "notice";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  title?: string;
}

function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function formatGithubAnnotation(annotation: GithubAnnotation): string {
  const properties: string[] = [];
  if (annotation.title !== undefined) {
    properties.push(`title=${escapeProperty(annotation.title)}`);
  }
  if (annotation.file !== undefined) {
    properties.push(`file=${escapeProperty(annotation.file)}`);
  }
  if (annotation.line !== undefined) {
    properties.push(`line=${Math.max(1, Math.trunc(annotation.line))}`);
  }
  if (annotation.endLine !== undefined) {
    properties.push(`endLine=${Math.max(1, Math.trunc(annotation.endLine))}`);
  }
  if (annotation.column !== undefined) {
    properties.push(`col=${Math.max(1, Math.trunc(annotation.column))}`);
  }

  const prefix = properties.length > 0 ? ` ${properties.join(",")}` : "";
  return `::${annotation.kind}${prefix}::${escapeData(annotation.message)}`;
}
