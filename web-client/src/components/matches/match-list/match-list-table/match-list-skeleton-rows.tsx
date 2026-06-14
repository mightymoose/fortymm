import { MatchListTableHead } from "./match-list-table-head";

export const MatchListSkeletonRows = () => {
  return (
    <table className="matches" aria-busy="true">
      <MatchListTableHead />
      <tbody>
        {Array.from({ length: 6 }).map((_, i) => (
          <tr key={i} className="skeleton-row" aria-hidden="true">
            <td colSpan={6}>
              <div className="skeleton-line" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
