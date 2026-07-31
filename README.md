# Guess the Redesign — setup guide

This turns the game into a live site that refreshes itself with 5 new
rounds every morning at 6:00 AM EST, and grows its own pool of candidate
sites every week so you never have to add rounds by hand. You don't need
to touch your Mac's terminal for any of this except the very last step
(pointing your domain).

## 1. Create a GitHub account (skip if you have one)

Go to https://github.com and sign up. It's free.

## 2. Create a new repository

1. Click the "+" in the top right → "New repository"
2. Name it anything, e.g. `guess-the-redesign`
3. Make it **Public** (required for free GitHub Pages)
4. Don't check any of the "initialize with..." boxes
5. Click "Create repository"

## 3. Upload these files

On the new repo's page, click "uploading an existing file" and drag in
every file and folder from this project:

- `index.html`
- `rounds-pool.json`
- `build-daily-rounds.js`
- `grow-pool.js`
- `package.json`
- `.gitignore`
- the `.github` folder (with both `workflows/daily.yml` and
  `workflows/grow-pool.yml` inside it)

GitHub's upload page supports dragging whole folders, so you can drag
the `.github` folder in directly. Commit the upload.

## 4. Get an Anthropic API key and add it as a secret

1. Go to https://console.anthropic.com and create an account if you
   don't have one, then add a payment method (a small minimum credit
   load is typical, but actual usage here costs roughly $0.25-$1/year)
2. Create an API key
3. Back in your GitHub repo, go to **Settings → Secrets and variables → Actions**
4. Click "New repository secret"
5. Name it `ANTHROPIC_API_KEY`, paste in your key, save

## 5. Turn on GitHub Pages

1. In your repo, go to **Settings → Pages**
2. Under "Build and deployment", set **Source** to "Deploy from a branch"
3. Set **Branch** to `main` and folder to `/ (root)`
4. Save

Give it a minute, then refresh that page — it'll show you a URL like
`https://yourusername.github.io/guess-the-redesign/`. That's your site,
though it won't have any rounds yet until step 6.

## 6. Run the workflow once to seed today's game

1. Go to the **Actions** tab in your repo
2. Click "Daily Redesign Update" in the left sidebar
3. Click "Run workflow" → "Run workflow" (green button)
4. Wait 1-3 minutes for it to finish (the little dot turns green)

This runs entirely on GitHub's servers, so none of the Mac/Chromium
issues from earlier apply here. It will commit `images/` and
`rounds-data.json` to your repo automatically, and your Pages site will
redeploy with them a minute or two later.

Visit your site URL again — you should see today's 5 rounds ready to play.

## 7. (Optional) Run the pool-growth workflow once too

Same idea, but click "Grow Round Pool" in the Actions sidebar instead,
then "Run workflow." This asks Claude for a few new candidate sites,
checks each one against the real Wayback Machine archive, and adds the
ones that check out to `rounds-pool.json`. You don't have to do this
manually, it also runs automatically every Monday, but running it once
now confirms your API key is working.

## 8. Point your domain at it

1. In your repo, go back to **Settings → Pages**
2. Under "Custom domain", type your domain (e.g. `guesstheredesign.com`) and save
3. GitHub will show you DNS records to add. Generally:
   - For an apex domain (`guesstheredesign.com`): add **A records** pointing to
     GitHub's IPs (GitHub will show you the exact ones)
   - For a `www` subdomain: add a **CNAME record** pointing to
     `yourusername.github.io`
4. Go to wherever you bought your domain (its DNS settings page) and add
   those records
5. DNS changes can take anywhere from a few minutes to a few hours to
   take effect

Once that propagates, your domain will show the live game.

## From here on

Nothing else to do. Every day at 6:00 AM EST, the daily workflow picks
5 rounds and captures fresh screenshots. Every Monday, the growth
workflow quietly adds a few new verified candidates to the pool. Both
just work in the background from here.

