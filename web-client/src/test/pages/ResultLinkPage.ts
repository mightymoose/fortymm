import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for `/r`, the public page a result link opens.
export class ResultLinkPage {
  // Renders `path`, such as `/r#<envelope>`. The page starts no session.
  static async render(path: string): Promise<ResultLinkPage> {
    await renderRoute(path)
    return new ResultLinkPage()
  }

  get heading(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The value shown for `term`, such as "Best of".
  value(term: string): string {
    const dt = screen.getAllByRole('term').find((element) => element.textContent === term)
    return dt?.nextElementSibling?.textContent ?? ''
  }

}
