import { buildProfileHeroView } from './profile-hero-display.factory'
import { profileHeroDisplayPage } from './profile-hero-display.page'

describe('ProfileHeroDisplay', () => {
  it('names the player in the page heading', () => {
    profileHeroDisplayPage.render({
      hero: buildProfileHeroView({ username: 'leo.mertens' }),
    })

    expect(
      profileHeroDisplayPage.getName('leo.mertens'),
    ).toBeInTheDocument()
  })

  it('shows when the player joined', () => {
    profileHeroDisplayPage.render({
      hero: buildProfileHeroView({ memberSince: 'Member since Mar 2024' }),
    })

    expect(profileHeroDisplayPage.queryMemberSince()).toHaveTextContent(
      'Member since Mar 2024',
    )
  })

  it('omits the member-since line when the view has none', () => {
    profileHeroDisplayPage.render({
      hero: buildProfileHeroView({ memberSince: null }),
    })

    expect(profileHeroDisplayPage.queryMemberSince()).not.toBeInTheDocument()
  })
})
