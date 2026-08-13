# syntax=docker/dockerfile:1
# Zero-dependency RS256 token issuer/JWKS server standing in for Keycloak
# in the e2e stack. See server.js's header for why this is real
# infrastructure, not an application mock.
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
