import { Card, CardContent, CardHeader } from "@/components/ui/card";

const SK = "md-sk animate-pulse";

/**
 * Loading placeholder for the {@link MatchInfo} sidebar card, shown as its
 * `<Suspense>` fallback. Wears the *same* shared-`Card` chrome as
 * `MatchInfoDisplay` — `Card asChild` around a `<section>`, a `CardHeader`, a
 * `CardContent` — so the card box and the label/value rows occupy the boxes the
 * loaded card will and nothing shifts when the data lands. Only the leaf text
 * becomes shimmer blocks. Renders a representative three rows (the loaded count
 * varies); each row's height is pinned by `.md-info-row`, not the bar inside it.
 * This mirrors `MatchInfoDisplay`'s markup by hand (Suspense unmounts the real
 * tree during load), so revisit it if that structure changes — the skeleton test
 * asserts the two chromes stay identical.
 */
export const MatchInfoSkeleton = () => {
  return (
    <Card asChild>
      <section role="status" aria-busy="true" aria-label="Loading match info">
        <CardHeader aria-hidden="true">
          <span className={`${SK} md-sk--card-title`} />
        </CardHeader>
        <CardContent aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="md-info-row">
              <span className={`${SK} md-sk--info-k`} />
              <span className={`${SK} md-sk--info-v`} />
            </div>
          ))}
        </CardContent>
      </section>
    </Card>
  );
};
