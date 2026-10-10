FROM oven/bun:1 AS build
WORKDIR /app
RUN groupadd -r --gid 3000 appgroup && useradd -r --uid 3000 -g appgroup appuser
COPY --chown=appuser:appgroup . .
RUN bun install --frozen-lockfile
RUN chown -R appuser:appgroup /app
USER 3000

ENTRYPOINT ["bun", "start"]