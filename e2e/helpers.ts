import { type Page } from "@playwright/test";

/** Wait for MDX content to finish rendering (h1 visible). */
export async function waitForContent(page: Page) {
  await page.waitForSelector("h1", { timeout: 30_000 });
  await page.waitForTimeout(1000);
}

/** Navigate to a page in the sidebar by name. */
export async function navigateTo(page: Page, pageName: string) {
  await page.click(`text=${pageName}`);
  await page.waitForTimeout(2000);
}

/** Get the currently editable element's info, or null. */
export async function getEditableElement(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[contenteditable="true"]');
    if (!el) return null;
    return {
      tag: el.tagName,
      text: el.textContent || "",
    };
  });
}

/** Find a text node by exact content and return its bounding rect center. */
export async function getTextNodeCenter(page: Page, text: string) {
  return page.evaluate((t) => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
    );
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.trim() === t) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const rect = range.getBoundingClientRect();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      }
    }
    return null;
  }, text);
}

/** Click away to blur the current editing element. */
export async function blur(page: Page) {
  await page.mouse.click(10, 10);
  await page.waitForTimeout(1500);
}

/** Check that no error banner is showing. */
export async function assertNoError(page: Page) {
  const error = await page.evaluate(() => {
    const el = document.querySelector('[class*="error"] pre');
    return el?.textContent || null;
  });
  return error;
}
