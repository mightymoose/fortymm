"""The account's device signing keys: register, list and revoke."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Path
from pydantic import BaseModel

from fortymm_api.auth import RequestAccount
from fortymm_api.database import DatabaseSession
from fortymm_api.services import signing_keys
from fortymm_api.signing_keys import KeyId
from fortymm_api.v1.errors import NO_SESSION, UNSUPPORTED_MEDIA_TYPE, Responses, errors
from fortymm_api.v1.types import HexBytes

router = APIRouter(prefix="/account/signing-keys", tags=["signing-keys"])

# A kid: 32 bytes in lowercase hex.
KEY_ID_PATTERN = r"^[0-9a-f]{64}$"

REGISTER_ERRORS: Responses = {
    **NO_SESSION,
    **errors(409, "Another account registered this key"),
    **UNSUPPORTED_MEDIA_TYPE,
    # This entry replaces FastAPI's own 422, so it repeats its body.
    422: {
        "description": (
            "The body is invalid. If the label, the public key or the proof"
            " breaks its rule, the body is in the `errors` shape instead"
        ),
        "content": {
            "application/json": {
                "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
            }
        },
    },
}
REVOKE_ERRORS: Responses = {
    **NO_SESSION,
    **errors(404, "The account has no key with this id"),
    **UNSUPPORTED_MEDIA_TYPE,
}


class AccountSigningKey(BaseModel):
    # The key's kid, the thumbprint its signatures cite, in lowercase hex.
    id: HexBytes
    label: str
    created_at: datetime
    # When the device signed out, or a newer device took its place past the
    # account's 20 live keys. The key still verifies what it signed.
    signed_out_at: datetime | None
    # When the account reported the device compromised. The key verifies
    # nothing since.
    revoked_at: datetime | None


class SigningKeyResponse(BaseModel):
    data: AccountSigningKey


class SigningKeysResponse(BaseModel):
    data: list[AccountSigningKey]


class RegisterKeyRequest(BaseModel):
    # The key's COSE_Key, in lowercase hex.
    public_key: HexBytes
    # The registration proof the key signed for this account, in lowercase hex.
    proof: HexBytes
    # The device's name, such as "Ann's iPhone". Trimmed, then 1 to 50
    # characters.
    label: str


def key_model(key: signing_keys.AccountSigningKey) -> AccountSigningKey:
    return AccountSigningKey(
        id=key.id,
        label=key.label,
        created_at=key.created_at,
        signed_out_at=key.signed_out_at,
        revoked_at=key.revoked_at,
    )


@router.post("", responses=REGISTER_ERRORS)
def register_signing_key(
    session: DatabaseSession, account: RequestAccount, body: RegisterKeyRequest
) -> SigningKeyResponse:
    """Register this device's signing key to the account, and return it.

    `proof` is the COSE_Sign1 that api/signed-results/README.md specifies,
    signed by the key over the session's account id. Registering a key the
    account already has returns it unchanged, signed out or revoked
    included. A key that another account registered answers 409.

    An account keeps at most 20 live keys. A new key signs out the oldest.
    """
    key = signing_keys.register_key(
        session,
        account.id,
        public_key=body.public_key,
        proof=body.proof,
        label=body.label,
    )
    return SigningKeyResponse(data=key_model(key))


@router.get("", responses=NO_SESSION)
def account_signing_keys(
    session: DatabaseSession, account: RequestAccount
) -> SigningKeysResponse:
    """List the account's signing keys, newest first, signed out and revoked
    ones included."""
    return SigningKeysResponse(
        data=[key_model(key) for key in signing_keys.account_keys(session, account.id)]
    )


@router.post("/{key_id}/revoke", responses=REVOKE_ERRORS)
def revoke_signing_key(
    session: DatabaseSession,
    account: RequestAccount,
    key_id: Annotated[str, Path(pattern=KEY_ID_PATTERN)],
) -> SigningKeyResponse:
    """Report a device compromised. Its key verifies nothing from now on.
    Revoking a revoked key changes nothing."""
    key = signing_keys.revoke_key(session, account.id, KeyId(bytes.fromhex(key_id)))
    return SigningKeyResponse(data=key_model(key))
