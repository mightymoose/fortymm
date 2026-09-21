"""Single-shot entry point for replaying and reconciling tournament payments."""

from app.tournament_payment_reconciliation import run_reconciliation_sweep


def main() -> None:
    run_reconciliation_sweep()


if __name__ == "__main__":
    main()
