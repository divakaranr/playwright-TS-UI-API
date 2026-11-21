import path from 'node:path';

import type { Download, FrameLocator, Locator, Page } from '@playwright/test';

import { withTimeout } from '../../utils/wait.util.js';

export interface DialogOptions {
  accept: boolean;
  /** Text for `prompt()` dialogs. */
  promptText?: string;
  timeoutMs?: number;
}

/**
 * Handles the next JavaScript dialog (alert/confirm/prompt) triggered by `action`
 * and returns its message. Registers the handler *before* the action so the
 * dialog can never be auto-dismissed by Playwright first.
 */
export async function handleNextDialog(
  page: Page,
  action: () => Promise<void>,
  options: DialogOptions,
): Promise<string> {
  const message = new Promise<string>((resolve, reject) => {
    page.once('dialog', (dialog) => {
      const text = dialog.message();
      const handled = options.accept ? dialog.accept(options.promptText) : dialog.dismiss();
      handled.then(() => resolve(text), reject);
    });
  });
  await action();
  return withTimeout(message, options.timeoutMs ?? 10_000, 'waiting for JavaScript dialog');
}

/** Returns a FrameLocator for an <iframe> element (use getByTitle/getByTestId to find the iframe). */
export function frameOf(iframe: Locator): FrameLocator {
  return iframe.contentFrame();
}

/** Runs `action`, waits for the new tab/popup it opens and returns it once loaded. */
export async function waitForNewTab(page: Page, action: () => Promise<void>): Promise<Page> {
  const pagePromise = page.context().waitForEvent('page');
  await action();
  const newPage = await pagePromise;
  await newPage.waitForLoadState('domcontentloaded');
  return newPage;
}

export interface DownloadResult {
  suggestedFilename: string;
  savedPath: string;
  download: Download;
}

/** Runs `action`, waits for the triggered download and saves it into `targetDir`. */
export async function captureDownload(
  page: Page,
  action: () => Promise<void>,
  targetDir: string,
): Promise<DownloadResult> {
  const downloadPromise = page.waitForEvent('download');
  await action();
  const download = await downloadPromise;
  const savedPath = path.join(targetDir, download.suggestedFilename());
  await download.saveAs(savedPath);
  return { suggestedFilename: download.suggestedFilename(), savedPath, download };
}

export type InMemoryFile = { name: string; mimeType: string; buffer: Buffer };
/** A file path, several paths, or in-memory file payload(s). */
export type UploadFile = string | string[] | InMemoryFile | InMemoryFile[];

/** Sets files on an <input type="file">. Accepts paths or in-memory files. */
export async function uploadFiles(input: Locator, files: UploadFile): Promise<void> {
  await input.setInputFiles(files);
}
