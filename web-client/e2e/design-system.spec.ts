import { test, expect } from '@playwright/test';
import { DesignSystemPage } from './page-objects/design-system.page';

test.describe('Design System', () => {
  test('should style the buttons correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.buttonShowcase.primaryButton).toHaveScreenshot('plain-button.png');
    await expect(designSystemPage.buttonShowcase.secondaryButton).toHaveScreenshot('secondary-button.png');
    await expect(designSystemPage.buttonShowcase.outlineButton).toHaveScreenshot('outline-button.png');
    await expect(designSystemPage.buttonShowcase.ghostButton).toHaveScreenshot('ghost-button.png');
    await expect(designSystemPage.buttonShowcase.destructiveButton).toHaveScreenshot('destructive-button.png');
    await expect(designSystemPage.buttonShowcase.linkButton).toHaveScreenshot('link-button.png');
    await expect(designSystemPage.buttonShowcase.disabledButton).toHaveScreenshot('disabled-button.png');
    await expect(designSystemPage.buttonShowcase.smallButton).toHaveScreenshot('small-button.png');
    await expect(designSystemPage.buttonShowcase.defaultButton).toHaveScreenshot('default-button.png');
    await expect(designSystemPage.buttonShowcase.largeButton).toHaveScreenshot('large-button.png');
    await expect(designSystemPage.buttonShowcase.iconButton).toHaveScreenshot('icon-button.png');
  });

  test('should style the inputs correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.inputShowcase.playerTagInput).toHaveScreenshot('player-tag-input.png');
    await expect(designSystemPage.inputShowcase.emailInput).toHaveScreenshot('email-input.png');
    await expect(designSystemPage.inputShowcase.disabledInput).toHaveScreenshot('disabled-input.png');
    await expect(designSystemPage.inputShowcase.searchInput).toHaveScreenshot('search-input.png');
  });

  // The Dialog/AlertDialog/Sheet showcases render static always-open facsimiles
  // (the real portaled components can't show their open state inside a demo
  // card). They're hand-authored static markup, so we assert their structure —
  // heading + actions — rather than pixel-snapshotting our own markup against
  // fragile per-platform baselines.
  test('renders the dialog facsimile with its actions', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const dialog = await designSystemPage.overlayShowcase.dialogPanel();
    await expect(
      dialog.getByRole('button', { name: 'Forfeit' }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('renders the alert dialog facsimile with its actions', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const alertDialog = await designSystemPage.overlayShowcase.alertDialogPanel();
    await expect(
      alertDialog.getByRole('button', { name: 'Delete' }),
    ).toBeVisible();
    await expect(
      alertDialog.getByRole('button', { name: 'Keep account' }),
    ).toBeVisible();
  });

  test('renders the sheet facsimile with its filter controls', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const sheet = await designSystemPage.sheetShowcase.sheetPanel();
    await expect(
      sheet.getByRole('button', { name: 'Apply filters' }),
    ).toBeVisible();
  });

  test('should style the toasts correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.feedbackShowcase.successToast).toHaveScreenshot('toast-success.png');
    await expect(designSystemPage.feedbackShowcase.errorToast).toHaveScreenshot('toast-error.png');
    await expect(designSystemPage.feedbackShowcase.infoToast).toHaveScreenshot('toast-info.png');
  });
});
