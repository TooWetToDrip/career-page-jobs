# Built from the repository root (see dockerContextDir in .actor/actor.json), because this
# Actor shares its feed-reading and charging code with the first Actor in src/.
FROM apify/actor-node:22

COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version

COPY src ./src
COPY actors/job-search ./actors/job-search

CMD node actors/job-search/src/main.js
