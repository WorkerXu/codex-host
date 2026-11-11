import { describe, expect, it } from "vitest";

import { projectGroupHideCss } from "../src/renderer-project-groups-hide.js";

describe("Project group hiding", () => {
  it("generates one scoped :has rule per project and de-duplicates ids", () => {
    const css = projectGroupHideCss(["local-alpha", "project-beta", "local-alpha"]);
    expect(css.match(/display: none !important;/g)).toHaveLength(2);
    expect(css).toContain('data-app-action-sidebar-project-id="local-alpha"');
    expect(css).toContain('data-app-action-sidebar-project-id="project-beta"');
    expect(css).toContain(
      'section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]',
    );
  });

  it("returns no stylesheet for an empty group", () => {
    expect(projectGroupHideCss([])).toBe("");
  });
});
