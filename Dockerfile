FROM oven/bun:1 AS build
WORKDIR /app
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
COPY --chown=appuser:appgroup . .
RUN bun install --frozen-lockfile
RUN chown -R appuser:appgroup /app
USER appuser

ENTRYPOINT ["bun", "start"]