import { useId } from "react";

import { Overline } from "@/components/overline";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

import { InfoRow } from "./match-info-display/info-row";
import { type MatchInfoView } from "./match-info-query";

export interface MatchInfoDisplayProps {
  info: MatchInfoView;
}

/**
 * The match-info sidebar card. Wears the shared design-system `Card` chrome
 * (`asChild`, so the panel stays a `<section aria-labelledby>` landmark rather
 * than an anonymous div) instead of the bespoke `.md-card` classes. The rows
 * live in a `<dl>` *inside* `CardContent` — `CardContent` is a plain div with
 * no `asChild`, and the description-list semantics matter more than saving a
 * wrapper. `MatchInfoSkeleton` mirrors this chrome; change them together.
 */
export const MatchInfoDisplay = ({ info }: MatchInfoDisplayProps) => {
  const id = useId();

  return (
    <Card asChild>
      <section aria-labelledby={id}>
        <CardHeader>
          <Overline as="h3" id={id}>
            Match info
          </Overline>
        </CardHeader>
        <CardContent>
          <dl>
            {info.rows.map((row) => (
              <InfoRow key={row.label} row={row} />
            ))}
          </dl>
        </CardContent>
      </section>
    </Card>
  );
};
