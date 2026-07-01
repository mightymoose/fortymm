import { test, expect } from '@playwright/test';

/** #263: the Avatar showcase must demo the IMAGE variant (a real
 * `AvatarImage`, not just initials) and label it "image · initials · stack". */
test.describe('Design System — Avatar showcase (#263)', () => {
    test('shows the IMAGE variant and labels it image · initials · stack', async ({
        page,
    }) => {
        await page.goto('/design-system');

        const avatar = page.getByRole('region', { name: 'Avatar' });
        await expect(avatar).toBeVisible();

        // Tag now advertises the IMAGE variant.
        await expect(avatar).toContainText('image · initials · stack');

        // A real avatar image renders (Radix only shows the <img> once it
        // loads; the data-URI source loads offline).
        const image = avatar.locator('img[data-slot="avatar-image"]');
        await expect(image).toBeVisible();

        // Stack circles keep their ring separators (the pre-existing half of
        // #263) — every overlapped avatar carries a ring.
        const ringed = avatar.locator('[data-slot="avatar"].ring-2');
        expect(await ringed.count()).toBeGreaterThanOrEqual(4);
    });
});
