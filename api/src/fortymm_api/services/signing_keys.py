"""Device signing keys. Each device holds a P-256 key, and the account it
signs for holds the public half, so a signed result's kid names an account
(#188).

A key belongs to one account for good. Adoption moves it to the adopting
account (MOVES_ON_ADOPT), and nothing else changes its owner.

A live key has neither signed_out_at nor revoked_at. Signing out and the cap
end a key's life on its device, but what it signed still verifies. Revoking
says the device was compromised: the key verifies nothing more.

This module is the only writer of signed_out_at and revoked_at.
"""

from typing import Final

# After a registration, the account has at most this many live keys: the new
# one and the newest LIVE_KEY_LIMIT - 1 others. An adoption can bring it
# more, which its next registration signs out.
LIVE_KEY_LIMIT: Final = 20
# The CHECK label_length repeats it.
LABEL_MAX_LENGTH: Final = 50
