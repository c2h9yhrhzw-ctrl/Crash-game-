
# Crash Arena

A mobile-friendly crash-style game using virtual credits.

## Requirements

- Node.js 20 or later
- npm

## Run locally

1. Install dependencies:

   npm install

2. Create a `.env` file using `.env.example` as a template.

3. Set `JWT_SECRET` to a long, random secret.

4. Start the server:

   npm start

5. Open http://localhost:3000

## Important

- Credits are virtual and have no cash value.
- Real-money deposits, betting and withdrawals are not implemented.
- This initial version needs automated tests, security review,
  persistent-database configuration and race-condition fixes
  before public deployment.
