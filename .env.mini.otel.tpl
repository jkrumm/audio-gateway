# Optional overlay: OpenTelemetry export from the mini instance to the VPS's
# public OTLP ingest (Traefik → ClickStack :4318, bearertokenauth). Layered by
# scripts/launch.sh ONLY when the key resolves from the mini's secrets cache;
# otherwise the instance runs with the exporter disabled (a true no-op).
# secrets-run resolves only whole-value op:// refs, hence the dedicated var.
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.jkrumm.com
OTEL_EXPORTER_OTLP_AUTHORIZATION=op://vps/argo/HYPERDX_API_KEY_PROD
