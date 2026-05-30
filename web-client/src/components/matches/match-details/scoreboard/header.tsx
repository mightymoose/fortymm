import { Suspense } from 'react'
import { HeaderData } from './header/header-data'
import { HeaderSkeleton } from './header/header-skeleton'

interface HeaderProps {
  matchId: string;
}

export function Header({ matchId }: HeaderProps) {
  return (
    <Suspense fallback={<HeaderSkeleton />}>
      <HeaderData matchId={matchId} />
    </Suspense>
  );
}
