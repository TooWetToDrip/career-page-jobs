# Career Page Jobs: Greenhouse, Lever, Ashby, Workable

Collect open jobs straight from company career pages and get them back in one clean format, whichever hiring system the company uses.

Many companies run their careers page on Greenhouse, Lever, Ashby or Workable. Each of those systems publishes the company's open jobs as a public list, with no login. This tool reads those public lists for the companies you name and returns one tidy row per job.

## What you get

One row per open job, with the same fields for every company:

- company, job title, department and team
- location, every other listed location, country
- remote or not, and the workplace type (remote, hybrid, on-site) when the company states it
- job type (full-time, internship and so on)
- date posted, and date updated when the system gives one
- link to the job and link to apply
- pay range when the company publishes one: lowest, highest, currency and period
- the full description as plain text (optional), and as HTML (optional)

## How to use it

1. **List the companies.** Paste the address of each company's jobs page, one per line. For example `https://boards.greenhouse.io/stripe`, `https://jobs.lever.co/palantir`, `https://jobs.ashbyhq.com/ramp` or `https://apply.workable.com/huggingface`. The short form `greenhouse:stripe` works too. Leave the list empty to try the tool on a small built-in starter list.
2. **Narrow it down (optional).** Keep only titles that contain certain words, drop titles that contain others, keep only certain locations, only remote jobs, or only jobs posted in the last N days. You can also cap the number of jobs per company.
3. **Run it.** Results appear in the dataset, ready to export as JSON, CSV or Excel, or to read through the API.

### Only what is new

Switch on **Only jobs that are new since the last run** and put the tool on a schedule. The first run returns everything that matches. Every later run returns only jobs it has not given you before, so a daily check hands you just the new openings and you pay only for those. A job that closes and later reopens counts as new again.

## Example result

```json
{
  "company": "Ramp",
  "source": "ashby",
  "companyId": "ramp",
  "id": "34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  "title": "Security Engineer, Cloud",
  "department": "Engineering",
  "team": "Backend",
  "location": "New York, NY (HQ)",
  "allLocations": ["New York, NY (HQ)", "Remote (Canada)"],
  "country": "USA",
  "remote": true,
  "workplaceType": "hybrid",
  "employmentType": "FullTime",
  "postedAt": "2026-04-07T17:12:35.753Z",
  "updatedAt": null,
  "url": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  "applyUrl": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application",
  "salaryMin": 211400,
  "salaryMax": 290600,
  "salaryCurrency": "USD",
  "salaryInterval": "1 YEAR",
  "salaryText": "$211.4K - $290.6K",
  "descriptionText": "ABOUT RAMP ...",
  "scrapedAt": "2026-10-08T07:00:00.000Z"
}
```

Fields a hiring system does not provide come back as `null`. Greenhouse and Workable do not publish pay as separate numbers, so the pay fields are empty for those companies.

## Price

You pay per job returned: **$1.50 per 1,000 jobs**, plus a start fee of a fraction of a cent per run. A run that returns 200 jobs costs about $0.30. Jobs removed by your filters are not charged, and with the only-new switch on, jobs you have already received are not charged again. If you set a spending limit for a run, the tool stops when it is reached and tells you so.

## What it does not do

- It reads only the public job lists that the hiring systems publish. It does not log in anywhere and does not get around any block.
- It does not collect recruiter names, email addresses or any other personal details.
- It does not cover companies whose careers page runs on another system. A line it cannot read is skipped, and the run log says which line and why.
- It makes about one request a second to each hiring system, so very long company lists take a little time.

Job descriptions are written by the employers and remain theirs. Use them for your own search, research or analysis. If you plan to republish them, check that you are allowed to.

## Common questions

**How do I find the right address?** Open the company's careers page and click through to the list of open roles. If the address contains `greenhouse.io`, `lever.co`, `ashbyhq.com` or `workable.com`, paste it in.

**A company returns nothing.** It may have no open roles, or its careers page may run on a different system. The run log explains each skipped line, and the `SUMMARY` record in the key-value store lists every company that could not be read.

**How fresh is the data?** Each run reads the live list, so results match what the career page shows at that moment.

**Something is wrong or missing.** Open an issue on the Issues tab with the company address you used. Issues are answered there.

This tool is not affiliated with or endorsed by Greenhouse, Lever, Ashby or Workable.
