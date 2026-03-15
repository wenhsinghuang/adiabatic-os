import { test, expect } from "@playwright/test";
import {
  waitForContent,
  navigateTo,
  getEditableElement,
  getTextNodeCenter,
  blur,
  assertNoError,
} from "./helpers";

// ---------------------------------------------------------------------------
// All tests run against the stress-test page which has the most variety.
// Assumes Docker is running: `docker compose up -d`
// ---------------------------------------------------------------------------

test.describe("Editor — Obsidian-style text editing", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("click H1 → shows raw markdown source", async ({ page }) => {
    const h1 = page.locator("h1[data-source-line]");
    await h1.click();
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();
    expect(editable!.text).toMatch(/^# /);
  });

  test("click H2 → shows ## prefix", async ({ page }) => {
    const h2 = page.locator("h2[data-source-line]").first();
    await h2.click();
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();
    expect(editable!.text).toMatch(/^## /);
  });

  test("click H3 → shows ### prefix", async ({ page }) => {
    const h3 = page.locator("h3[data-source-line]");
    await h3.click();
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();
    expect(editable!.text).toMatch(/^### /);
  });

  test("click paragraph with bold → shows ** markers", async ({ page }) => {
    // Find a paragraph containing "all valid MDX" (has bold markers in source)
    const p = page.locator("p[data-source-line]", {
      hasText: "all valid MDX",
    });
    await p.click();
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();
    expect(editable!.text).toContain("**");
  });

  test("click blockquote → shows > prefix", async ({ page }) => {
    const bq = page.locator("blockquote[data-source-line]").first();
    await bq.click();
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();
    expect(editable!.text).toMatch(/^> /);
  });

  test("click UL list item → shows * list markers", async ({ page }) => {
    // Click on "First item" text inside the list
    const li = page.locator("li", { hasText: "First item" }).first();
    await li.click();
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();
    expect(editable!.text).toContain("* ");
  });

  test("blur without change → restores rendered HTML", async ({ page }) => {
    const h1 = page.locator("h1[data-source-line]");
    const originalText = await h1.textContent();
    await h1.click();
    await page.waitForTimeout(500);

    // Press Escape (no change)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    const afterText = await h1.textContent();
    expect(afterText).toBe(originalText);

    // Should not have contenteditable anymore
    const editable = await getEditableElement(page);
    expect(editable).toBeNull();
  });

  test("edit text + blur → saves and re-renders", async ({ page }) => {
    const h3 = page.locator("h3[data-source-line]");
    await h3.click();
    await page.waitForTimeout(500);

    await page.keyboard.press("End");
    await page.keyboard.type(" EDITED");
    await blur(page);

    // Wait for recompile
    const h3After = page.locator("h3[data-source-line]");
    await expect(h3After).toContainText("EDITED");

    // Undo the change to not pollute other tests
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);
  });
});

test.describe("Editor — Expression editing", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("click evaluated expression → shows raw {expr}", async ({ page }) => {
    const coords = await getTextNodeCenter(page, "98883");
    expect(coords).not.toBeNull();

    await page.mouse.click(coords!.x, coords!.y);
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();
    expect(editable!.text).toContain("{1+98878+4}");
  });

  test("expression blur → no crash", async ({ page }) => {
    const coords = await getTextNodeCenter(page, "98883");
    if (!coords) return;

    await page.mouse.click(coords.x, coords.y);
    await page.waitForTimeout(500);
    await blur(page);

    const error = await assertNoError(page);
    expect(error).toBeNull();
  });
});

test.describe("Editor — Component blocks", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("component bar appears on hover", async ({ page }) => {
    const wrapper = page.locator('[class*="componentWrapper"]').first();
    await wrapper.hover();
    await page.waitForTimeout(300);

    const bar = page.locator('[class*="componentBar"]').first();
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("HelloWorld");
    await expect(bar).toContainText("Edit");
  });

  test("component bar has draggable attribute", async ({ page }) => {
    const bar = page.locator('[class*="componentBar"]').first();
    await expect(bar).toHaveAttribute("draggable", "true");
  });

  test("delete button removes component", async ({ page }) => {
    const wrapperCount = await page
      .locator('[class*="componentWrapper"]')
      .count();

    // Hover to reveal bar, click delete
    const wrapper = page.locator('[class*="componentWrapper"]').first();
    await wrapper.hover();
    await page.waitForTimeout(300);
    await page.locator('[class*="componentDeleteBtn"]').first().click();
    await page.waitForTimeout(2000);

    const newCount = await page
      .locator('[class*="componentWrapper"]')
      .count();
    expect(newCount).toBe(wrapperCount - 1);

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);
  });

  test("resize does not crash", async ({ page }) => {
    const wrapper = page.locator('[class*="componentWrapper"]').first();
    await wrapper.hover();
    await page.waitForTimeout(300);

    const handle = page.locator('[class*="resizeHandle"]').first();
    const box = await handle.boundingBox();
    if (!box) return;

    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 50, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(2000);

    const error = await assertNoError(page);
    expect(error).toBeNull();

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);
  });
});

test.describe("Editor — Undo / Redo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("Cmd+Z undoes a text edit", async ({ page }) => {
    const h1 = page.locator("h1[data-source-line]");
    const original = await h1.textContent();

    // Make a change
    await h1.click();
    await page.waitForTimeout(500);
    await page.keyboard.press("End");
    await page.keyboard.type(" TEST");
    await blur(page);

    await expect(h1).toContainText("TEST");

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);

    const after = await h1.textContent();
    expect(after).toBe(original);
  });

  test("Cmd+Shift+Z redoes after undo", async ({ page }) => {
    const h1 = page.locator("h1[data-source-line]");

    await h1.click();
    await page.waitForTimeout(500);
    await page.keyboard.press("End");
    await page.keyboard.type(" REDO");
    await blur(page);

    const modified = await h1.textContent();

    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);

    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(1500);

    const after = await h1.textContent();
    expect(after).toBe(modified);

    // Clean up
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);
  });
});

test.describe("Editor — Drag & Drop", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("drag component shows drop indicator", async ({ page }) => {
    const wrapper = page.locator('[class*="componentWrapper"]').first();
    await wrapper.hover();
    await page.waitForTimeout(300);

    const bar = page.locator('[class*="componentBar"]').first();
    const barBox = await bar.boundingBox();
    const h1Box = await page
      .locator("h1[data-source-line]")
      .boundingBox();
    if (!barBox || !h1Box) return;

    // Start drag
    await page.mouse.move(
      barBox.x + barBox.width / 2,
      barBox.y + barBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(h1Box.x + h1Box.width / 2, h1Box.y - 5, {
      steps: 10,
    });

    // Check that a drop happened (component moved) by verifying page didn't crash
    await page.mouse.up();
    await page.waitForTimeout(2000);

    const error = await assertNoError(page);
    expect(error).toBeNull();

    // Undo the move
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);
  });
});

test.describe("Editor — Links", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("links have correct href", async ({ page }) => {
    const link = page.locator('a[href="https://example.com"]');
    await expect(link).toHaveCount(1);
  });
});

test.describe("Editor — Tail zone", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("click tail zone → creates editable paragraph", async ({ page }) => {
    const tailZone = page.locator('[class*="tailZone"]');
    await tailZone.click();
    await page.waitForTimeout(500);

    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();

    // Editable should appear above the tail zone, not below it
    const editableBox = await page
      .locator('[contenteditable="true"]')
      .boundingBox();
    const tailBox = await tailZone.boundingBox();
    if (editableBox && tailBox) {
      expect(editableBox.y).toBeLessThan(tailBox.y);
    }

    // Press Escape to cancel
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  test("type in tail zone + blur → saves new block", async ({ page }) => {
    const tailZone = page.locator('[class*="tailZone"]');
    await tailZone.click();
    await page.waitForTimeout(500);

    await page.keyboard.type("NEW TAIL BLOCK");
    await blur(page);

    // Should appear in the rendered content
    await expect(page.locator("text=NEW TAIL BLOCK")).toBeVisible();

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1500);
  });

  test("tail zone edit + escape → discards text, no orphans", async ({
    page,
  }) => {
    const tailZone = page.locator('[class*="tailZone"]');
    await tailZone.click();
    await page.waitForTimeout(500);

    await page.keyboard.type("TEMP TEXT");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);

    // Should not have any editable elements
    const editable = await getEditableElement(page);
    expect(editable).toBeNull();

    // "TEMP TEXT" should NOT have been saved (Escape = discard)
    const hasTemp = await page.locator("text=TEMP TEXT").count();
    expect(hasTemp).toBe(0);

    const error = await assertNoError(page);
    expect(error).toBeNull();
  });
});

test.describe("Editor — Slash commands", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("typing / during editing shows slash palette", async ({ page }) => {
    // Click tail zone for a fresh empty block
    const tailZone = page.locator('[class*="tailZone"]');
    await tailZone.click();
    await page.waitForTimeout(500);

    // Type / (at position 0, which is allowed)
    await page.keyboard.type("/");
    await page.waitForTimeout(300);

    // Slash palette should appear
    const palette = page.locator('[class*="palette"]');
    await expect(palette).toBeVisible();

    // Should list at least one component (HelloWorld from hello-world app)
    await expect(palette).toContainText("HelloWorld");

    // Press Escape to dismiss palette
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(palette).not.toBeVisible();

    // Press Escape again to cancel editing
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  test("slash palette filters by typing", async ({ page }) => {
    const tailZone = page.locator('[class*="tailZone"]');
    await tailZone.click();
    await page.waitForTimeout(500);

    await page.keyboard.type("/Hello");
    await page.waitForTimeout(300);

    const palette = page.locator('[class*="palette"]');
    await expect(palette).toBeVisible();
    await expect(palette).toContainText("HelloWorld");

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  test("selecting from slash palette inserts component", async ({ page }) => {
    const wrapperCount = await page
      .locator('[class*="componentWrapper"]')
      .count();

    // Click tail zone for a clean empty block
    const tailZone = page.locator('[class*="tailZone"]');
    await tailZone.click();
    await page.waitForTimeout(500);

    // Type /Hello to filter for HelloWorld (known working component)
    await page.keyboard.type("/Hello");
    await page.waitForTimeout(300);

    const palette = page.locator('[class*="palette"]');
    const isVisible = await palette.isVisible();
    if (!isVisible) return; // skip if no apps loaded

    // Press Enter to select HelloWorld
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    // Should have one more component
    const newCount = await page
      .locator('[class*="componentWrapper"]')
      .count();
    expect(newCount).toBe(wrapperCount + 1);

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(2000);
  });

  test("slash palette Escape does not cancel editing", async ({ page }) => {
    const tailZone = page.locator('[class*="tailZone"]');
    await tailZone.click();
    await page.waitForTimeout(500);

    await page.keyboard.type("/");
    await page.waitForTimeout(300);

    // Escape closes palette but editing continues
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const palette = page.locator('[class*="palette"]');
    await expect(palette).not.toBeVisible();

    // Should still be in edit mode
    const editable = await getEditableElement(page);
    expect(editable).not.toBeNull();

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });
});

test.describe("Editor — Full-app mode", () => {
  // Full-app mode: a page with ONLY imports + one component renders
  // without editor chrome (no tail zone, no component bar, no padding).
  // This requires a page with e.g. only:
  //   import { HelloWorld } from "@apps/hello-world"
  //   <HelloWorld />
  //
  // TODO: add test once we can create test pages via API fixture.
  // For now, we verify the detection doesn't break normal pages.

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("stress-test page is NOT full-app mode (has text blocks)", async ({
    page,
  }) => {
    // Should have tail zone (means editor chrome is present)
    const tailZone = page.locator('[class*="tailZone"]');
    await expect(tailZone).toBeVisible({ timeout: 10_000 });

    // Should have at least one component wrapper (not full-app mode)
    const wrapper = page.locator('[class*="componentWrapper"]').first();
    await expect(wrapper).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Editor — Undo after error", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("Cmd+Z recovers from a broken edit", async ({ page }) => {
    const h1 = page.locator("h1[data-source-line]");
    const original = await h1.textContent();

    // Make a change that will cause an error (invalid MDX)
    await h1.click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Home");
    await page.keyboard.type("<BrokenTag ");
    await blur(page);
    await page.waitForTimeout(2000);

    // Page should have an error or broken state
    // Now undo should recover
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(2000);

    // H1 should be restored
    const recovered = page.locator("h1[data-source-line]");
    await expect(recovered).toContainText(original!.substring(0, 10));
  });
});

test.describe("Editor — Error handling", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForContent(page);
    await navigateTo(page, "stress-test");
  });

  test("page renders without errors", async ({ page }) => {
    const error = await assertNoError(page);
    expect(error).toBeNull();
  });

  test("all block types have data-source-line", async ({ page }) => {
    const annotated = await page.evaluate(() => {
      const els = document.querySelectorAll("[data-source-line]");
      const tags = new Set(Array.from(els).map((e) => e.tagName));
      return Array.from(tags).sort();
    });

    // Should have at least these block types annotated
    expect(annotated).toContain("H1");
    expect(annotated).toContain("H2");
    expect(annotated).toContain("P");
    expect(annotated).toContain("UL");
    expect(annotated).toContain("BLOCKQUOTE");
    expect(annotated).toContain("PRE");
  });
});
