"""Print the app's OpenAPI spec. `./bin/mise run api:openapi` writes it to openapi.json."""

import json

from app.main import app

print(json.dumps(app.openapi(), indent=2))
