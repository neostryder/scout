// Where a person can get a newer version by hand when Scout has no updater for it. Only https pages are offered, and
// a GitHub project goes to its latest release. Nothing here downloads anything.

function asHttps(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function downloadLink(ecosystem: string, key: string, homepage: string | null): string | null {
  const home = asHttps(homepage);
  if (home && home.hostname === "github.com") {
    const [owner, repo] = home.pathname.split("/").filter(Boolean);
    if (owner && repo) return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}/releases/latest`;
  }
  if (home) return home.href;
  if (ecosystem === "go-bin" && /^[a-z0-9.-]+\.[a-z]+\/[A-Za-z0-9_./~-]+$/.test(key)) return `https://pkg.go.dev/${key}`;
  if (ecosystem === "npm" && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(key)) return `https://www.npmjs.com/package/${key}`;
  if ((ecosystem === "pipx" || ecosystem === "uv-tool" || ecosystem === "pypi") && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return `https://pypi.org/project/${key}/`;
  if (ecosystem === "winget" && /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return `https://winget.run/pkg/${key.replace(".", "/")}`;
  if (ecosystem === "msstore" && /^[A-Za-z0-9]{10,14}$/.test(key)) return `https://apps.microsoft.com/detail/${key}`;
  if (ecosystem === "brew" && /^[a-z0-9@._+-]+$/i.test(key)) return `https://formulae.brew.sh/formula/${key}`;
  if (ecosystem === "cask" && /^[a-z0-9@._+-]+$/i.test(key)) return `https://formulae.brew.sh/cask/${key}`;
  return null;
}
