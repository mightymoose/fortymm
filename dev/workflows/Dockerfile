# The tools for the repository's GitHub workflows (the workflows task):
# actionlint, to lint them; yq and jq, to read them for
# .github/scripts/check-workflows.sh; bash and jq, for the scripts the
# workflows run and their tests. Only actionlint's binary is copied, so it
# doesn't also run shellcheck over the workflows' run: scripts.
FROM rhysd/actionlint:1.7.7 AS actionlint

FROM alpine:3.22

RUN apk add --no-cache bash jq yq-go
COPY --from=actionlint /usr/local/bin/actionlint /usr/local/bin/actionlint

ENV HOME=/tmp
WORKDIR /repo
