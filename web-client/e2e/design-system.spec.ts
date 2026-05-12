import { test, expect } from '@playwright/test';

test.describe('Design System', () => {
  test('should style the buttons correctly', async ({ page }) => {
    await page.goto('/design-system');

    const buttonShowcase = page.getByRole('region', { name: 'Button' });

    await expect(buttonShowcase.getByRole('button', { name: 'Log a match' })).toHaveScreenshot('plain-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Save draft' })).toHaveScreenshot('secondary-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Cancel' })).toHaveScreenshot('outline-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Skip' })).toHaveScreenshot('ghost-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Forfeit match' })).toHaveScreenshot('destructive-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Read manifesto' })).toHaveScreenshot('link-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Disabled' })).toHaveScreenshot('disabled-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Small' })).toHaveScreenshot('small-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Default' })).toHaveScreenshot('default-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Large' })).toHaveScreenshot('large-button.png');
    await expect(buttonShowcase.getByRole('button', { name: 'Add' })).toHaveScreenshot('icon-button.png');
  });
});
