"""Single-shot deployment entry point for checkout receipt-address cleanup."""

from app.tournament_payment_receipts import run_receipt_pii_sweep

if __name__ == "__main__":
    run_receipt_pii_sweep()
