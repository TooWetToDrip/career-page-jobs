# Career Site Job Search

Search open jobs across thousands of company career sites with a keyword. No company links needed.

Type what you are looking for, such as `data engineer`, `"account executive"` or `nurse`, add a place or tick remote if you like, and get back one clean row per matching job, newest first. The index holds more than 400,000 open jobs read straight from the career sites of more than 12,000 companies, and it is rebuilt every day.

## Where the jobs come from

Thousands of companies run their careers page on Greenhouse, Lever, Ashby or Workable. Each of those systems publishes a company's open jobs as a public list, with no login. Once a day this tool's index reads those public lists for every company in its directory and records each open job's title, place, dates, pay range and links. Your search runs against that index, which is why it answers in seconds.

The run's status line tells you how many jobs and companies the index held and how many hours ago it was rebuilt.

## What you get

One row per job, with the same fields whichever system the company uses:

- company, job title, department and team
- location, every other listed location, country
- remote or not, and the workplace type (remote, hybrid, on-site) when the company states it
- job type (full-time, internship and so on)
- date posted, and date updated when the system gives one
- link to the job and link to apply
- pay range when the company publishes one: lowest, highest, currency and period
- optionally, the full description as plain text and as HTML (see "Live check" below)

## How to use it

1. **Keywords.** One search per line. A job is kept when its title matches at least one line.
   - `data engineer` finds titles that contain both words in any order: "Senior Data Engineer" and "Engineer, Data Platform".
   - `"machine learning"` in double quotes finds that exact phrase.
   - Matching is on whole words, so `java` does not match "JavaScript". Capitals and accents do not matter.
   - Leave it empty to get every title.
2. **Narrow it down (optional).** Leave out titles with certain words, keep only certain places, only remote jobs, or only jobs posted in the last N days. You can also search only named companies, or cap how many jobs any one company contributes.
3. **Set the maximum number of jobs.** The newest matching jobs come first. You pay only for jobs returned.
4. **Run it.** Results appear in the dataset, ready to export as JSON, CSV or Excel, or to read through the API.

### Places

Places are written the way each company writes them: "New York, NY", "NYC", "Remote - US", "Germany". List the variants you care about, one per line, for example `United States`, `USA` and `US`. A place matches as whole words, so `US` does not match "Australia".

### Live check and descriptions

Switch on **Check each job live and add the full description** and the tool reads the career site of each matching company during your run. That adds the full description and leaves out any job that has closed since the index was last rebuilt. It takes roughly a second per company, so use it with a maximum number of jobs.

### Only what is new

Switch on **Only jobs I have not been given before** and put the search on a daily schedule. The first run returns everything that matches. Each later run returns only jobs it has not handed you before for that same search, so you receive, and pay for, just the new openings.

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
  "liveChecked": false,
  "scrapedAt": "2026-10-08T05:40:00.000Z"
}
```

`scrapedAt` is when that company's career site was last read: during the daily index build, or during your run when the live check is on (`liveChecked: true`). Fields a hiring system does not provide come back as `null`. Greenhouse and Workable do not publish pay as separate numbers, and Greenhouse gives the department only with the live check on.

## Price

You pay per job returned: **$1.50 per 1,000 jobs**, plus a start fee of a fraction of a cent per run. A search that returns 100 jobs costs about $0.15. Jobs your filters remove are not charged, and with the only-new switch on, jobs you have already received are not charged again. If you set a spending limit for a run, the tool stops when it is reached and tells you so.

## What it does not do

- It covers companies whose careers page runs on Greenhouse, Lever, Ashby or Workable and that are in its directory. It is not every job on the internet, and it leans towards technology companies and startups, which use these systems most.
- A few of the career sites belong to recruiters and staffing firms that post many jobs for other employers. If one of them fills your list, set **Maximum jobs per company**.
- Keywords search the job title, not the description text.
- The index is rebuilt once a day, so a job posted this morning may appear tomorrow, and a job filled today may still show until the next rebuild. Use the live check when that matters.
- It reads only the public job lists that the hiring systems publish. It does not log in anywhere and does not get around any block.
- It does not collect recruiter names, email addresses or any other personal details.

Job descriptions are written by the employers and remain theirs. Use them for your own search, research or analysis. If you plan to republish them, check that you are allowed to.

## Common questions

**A company I expect is missing.** It may have no open roles today, or its careers page may run on a different system, or it may not be in the directory yet. Open an issue on the Issues tab with the company's careers page address and it can be added.

**Can I give it my own list of company career pages?** Use the companion tool, [Career Page Jobs Scraper](https://apify.com/toowettodrip/career-page-jobs), which reads any Greenhouse, Lever, Ashby or Workable career page you paste, live.

**How fresh is the data?** The status line of every run says how many hours ago the index was rebuilt. With the live check on, each returned job was confirmed open during your run.

**Something is wrong or missing.** Open an issue on the Issues tab with the search you ran. Issues are answered there.

This tool is not affiliated with or endorsed by Greenhouse, Lever, Ashby or Workable.
