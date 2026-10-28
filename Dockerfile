# Tests: mesh builds this stage first (with.test_target: test). Install
# scripts and tests run only inside buildkitd's sandbox. A failure stops the deploy.
FROM oven/bun:1 AS test
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun test

# The image that ships (unchanged).
FROM oven/bun:1 AS build
WORKDIR /app
RUN groupadd -r --gid 3000 appgroup && useradd -r --uid 3000 -g appgroup appuser
COPY --chown=appuser:appgroup . .
RUN bun install --frozen-lockfile
RUN chown -R appuser:appgroup /app
USER 3000

ENTRYPOINT ["bun", "start"]