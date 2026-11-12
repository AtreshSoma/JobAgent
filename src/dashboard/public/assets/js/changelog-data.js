/**
 * The changelog, newest release first. Plain data with no DOM access, so it can
 * be tested directly and a new release is one entry at the top.
 *
 * Written for the person using the app, not the person building it: say what
 * they can now DO or SEE, in the words the screen uses. Keep each line short.
 *
 * Groups, in the order they are shown:
 *   new       something that did not exist before
 *   improved  something that existed and is now clearer, faster or calmer
 *   fixed     something that was wrong and no longer is
 */

export const CHANGELOG_GROUPS = Object.freeze([
  ['new', 'New'],
  ['improved', 'Improvements'],
  ['fixed', 'Fixes'],
]);

export const CHANGELOG = Object.freeze([
  {
    date: '2026-11-12',
    summary: 'Auto-fill completes far more of each application, asks you only what it cannot answer, and never acts on an approval you did not give. And Explore JobAgent shows how all of it works.',
    safety: 'Nothing is submitted without your review. That has not changed.',
    groups: {
      new: [
        'Explore JobAgent, the compass icon in the header: follow one example posting from discovery to your Submit, and clear each of the two signals yourself.',
        'How it works, inside Explore: a system map you can follow line by line, a score lab that shows how a score is reached, and where each part lives in the code.',
        'Unapprove, in a job\'s detail: take an approval back before anything is filled.',
        '"I submitted it myself" on a job whose auto-fill stopped, and then "Yes, it went through" or "No, it didn\'t" to settle it. No puts the job back so you can try again.',
        'See what stopped it, on Today and in a job\'s detail, goes straight to the reason an auto-fill stopped.',
        'A notice when JobAgent was updated after it started, so you know to restart it before trying auto-fill again.',
      ],
      improved: [
        'Auto-fill reads more application forms: dropdown menus drawn by the site (Rippling and others), questions printed above a box, styled checkboxes and radio buttons, and Apply buttons that open the form on the same page or in a new tab.',
        'A question auto-fill cannot answer is shown in the form\'s own words, with the choices the form offers, instead of "Search", "Select" or a code.',
        'Fields the site has already filled, such as the phone country code, are left as they are and no longer reported as questions.',
        'Current company is filled from the role your profile marks as current.',
        '"Are you legally authorized to work in the United States?" is answered Yes when your saved answer or your stated status says so. It is never answered No for you, and never when the question also asks about sponsorship or "any employer".',
        'When a form does not take a plain-text cover letter, the Word version of the same letter is sent instead.',
        'Your approval now covers what you approved. If the resume, the cover letter or your saved answers change afterwards, auto-fill stops and asks you to approve again.',
        'Jobs whose stated requirement you do not meet, such as a licence, a degree or years of experience, stay in Queue with the reason shown, however high they score.',
        'Skills a posting lists only as preferred count for less than required ones, seniority is read the way each profession uses it, and lists show the best tier first.',
        'Your saved jobs are scored again on the next search, so some scores and tiers will move.',
        '"Sr." and "Senior", or "Corp" and "Corporation", are now seen as the same job when spotting duplicates.',
        'Tab counts change as soon as you decide on a job, and colours and screen-reader labels pass an accessibility check.',
        'The launcher only shares your dashboard access link with a JobAgent it can confirm is yours.',
      ],
      fixed: [
        'A site\'s display-language picker no longer stops auto-fill on the job description with "resume upload input not found".',
        'A resume or cover letter is no longer reported as "did not remain attached" when the form shows it attached.',
        'Your details no longer go into someone else\'s fields, such as a reference, an emergency contact or a previous employer. Loosely matched or sensitive questions are left for you.',
        'An application is only called ready for you when every required field is filled, and a Next button that changes nothing stops the run instead of repeating.',
        'A thank-you message that was already on the page is no longer taken as proof that an application was sent.',
        'Workday\'s "Apply Manually" step and other pop-up steps are followed instead of stopping the run.',
        'Pressing Enter again after Approve can no longer start auto-fill, and rejected or closed jobs no longer offer it.',
        'One click rejects one job, and Undo puts back exactly what you had decided before.',
        'An auto-fill cut short by closing JobAgent is marked as interrupted instead of looking as if it is still running.',
        'Messages meant for screen readers are no longer mistaken for form errors.',
        'A job list made by a newer version of JobAgent is left untouched instead of being changed.',
        'On a phone, the System health panel no longer runs off the edge of the screen.',
      ],
    },
  },
  {
    version: 'v0.2.0',
    date: '2026-11-11',
    summary: 'Writing help that only uses your own resume, daily backups, email replies, and a locked-down dashboard.',
    safety: 'Nothing is submitted without your review. That has not changed.',
    groups: {
      new: [
        'Rewrite suggestions, in a job\'s detail: a model proposes clearer wordings of your bullets for that job. Each one is checked against your own resume first, and nothing changes until you accept it. Turn on with RESUME_REWRITE=suggest.',
        'Ask for a specific change ("lead the Power BI bullet with its outcome"). What your resume cannot back is declined, with the reason.',
        'Cover letters can be written paragraph by paragraph from your resume (COVER_LETTER_MODE=grounded), and every letter is also saved as a Word document.',
        'Document versions: each prepared resume and letter is kept, can be compared word by word, and restored. Once you submit, they are frozen as sent.',
        'Daily backups of every job list, checked after copying, plus Back up now under System health. One file moves everything to another computer: npm run export.',
        'Email replies, in the Activity menu: JobAgent reads replies about applications you submitted and suggests the outcome, showing the sentence that says so. It never sends, moves or marks mail.',
        'Draft a reply to an employer email from your resume, with what only you can fill in left as a gap. Copy it, open it in your email app, or download it.',
        'Export your follow-ups to Google Calendar, Outlook or Apple Calendar (.ics), and optional desktop alerts when one is due.',
        'Rank top matches by meaning, in the Activity menu: a second number beside the fit score, with the resume lines each posting is closest to.',
        'What gets interviews, under Applications: which sources, systems and score ranges led to interviews, once there is enough to tell.',
        'Use your job data from Claude or another assistant through an MCP server (npm run mcp). It can read, add a note and record an outcome, and has no way to apply or submit.',
        'Choose the AI provider: any OpenAI-compatible server, Anthropic, or Ollama and LM Studio on your own computer.',
      ],
      improved: [
        'The dashboard now needs its own access link, so other programs and other accounts on this computer cannot use it. The launcher opens the link for you.',
        'Links you paste, and links found in postings, are refused if they lead to this computer or your home network, checked at the moment of connecting.',
        'A resume PDF is always made: when Word or LibreOffice is missing, JobAgent prints it with its own browser.',
        'The same job advertised for two different teams is no longer merged into one; the same role in many cities still is.',
        'Light theme colours, tables and dialogs pass an accessibility check, and the Changelog can be scrolled with the keyboard.',
        'Passwords such as the inbox app password can be kept in your system keychain instead of .env (npm run secret).',
        'With cover letters written from your resume, any one job can use your own template instead: Use my template for this job instead, in its packet.',
      ],
      fixed: [
        'Auto-submit is refused on any application system that has not had a supervised live run recorded, even though it passed every saved-page test.',
        'The support matrix said Oracle Recruiting found nothing and that Adzuna was on by default; both are now correct.',
        'A copy of the job store is taken before any database upgrade, so an upgrade can be undone.',
        'On Windows, saving a password failed when JobAgent was started from PowerShell 7.',
      ],
    },
  },
  {
    date: '2026-11-10',
    summary: 'Share the jobs you are looking at as a neat email, and profile forms that never lose what you type.',
    safety: 'Nothing is submitted without your review. That has not changed.',
    groups: {
      new: [
        'Email list, next to the page numbers under the Jobs table, turns the jobs you are viewing into an email draft with a clickable link to each posting. It follows your filters and tab, or uses only the jobs you ticked.',
        'Copy the email and paste it into Gmail, Outlook or Apple Mail with the links intact, open it straight in your email app, or download it as a draft. Nothing is sent from JobAgent.',
        'Also in Activity, under Reports and exports: Email these jobs.',
      ],
      improved: [
        'Edit profile and Add profile mark what is required, keep Save off until it can work, and say why right next to the button.',
        'A problem with a field, such as a missing name, an email or phone number that looks wrong, or years of experience that are not a number, shows when you leave the box, not while you are still typing.',
        'When an answer is refused, for example because it contradicts your sponsorship setting, the reason appears on that answer and what you typed is kept.',
        'Example text such as "Your City" now shows as a grey hint in an empty box, instead of looking like your real answer.',
        'On Mac and Linux, the start script switches to the right version of Node through nvm when it can.',
        'Security updates for the tools JobAgent is built on, so a fresh install reports no known vulnerabilities.',
      ],
      fixed: [
        'Saving one part of Edit profile no longer wipes what you typed in the other parts.',
        'Clicking outside a window, or pressing Esc, Close or Cancel, now asks before throwing away what you typed.',
        'Pressing Enter in a field no longer saves and closes the window by accident. Press Ctrl or ⌘ + Enter to save from the keyboard.',
        'On Linux, a desktop alert for a job whose title starts with a dash now shows that title instead of failing.',
      ],
    },
  },
  {
    date: '2026-11-01',
    summary: 'A cleaner look, smarter job actions, and job search for more careers.',
    safety: 'Nothing is submitted without your review. That has not changed.',
    groups: {
      new: [
        'Light and dark theme switch in the top-right corner. It remembers your choice.',
        'Two new menus in the header: Activity (run history, data quality, system health, reports and exports) and Profile (master resume, application profile, resume library, keyboard shortcuts).',
        'Job search now reaches pharma, life sciences, cybersecurity, Java and full-stack roles, with 45 more employers added, including Johnson & Johnson, Merck, AstraZeneca, Novartis, Amgen, IQVIA, Northrop Grumman, Leidos, Cloudflare and Zscaler.',
        'Switch between people from the Profile menu in the top-right corner. Its button shows the initials of whoever you are searching as, and every switch offers "Switch back".',
        'Add profile: add another person in one short form, from their resume or by typing their details. Each person gets their own jobs, resume and applications, and the Jobs, Today and Applications tabs always show the person you are searching as.',
        'Edit a profile\'s name, email, job titles, location and level at any time, without uploading a resume.',
        'Remove profile, next to Add profile in the Profile menu. Pick the person and they leave the list; their profile is archived and their jobs, resume and applications are kept on this computer, never erased. The person you are searching as cannot be removed until you switch away.',
        'A new profile can start with matching jobs already found in another person\'s list, so their Jobs tab is not empty while their first search runs. Only the postings are copied, never scores, notes or applications.',
        'This changelog, linked from the bottom of every page.',
      ],
      improved: [
        'Selecting jobs: the action bar now sits on the table header and never covers a job. It highlights the one next step that fits your selection (Prepare, Approve or Auto-fill), and a greyed-out action tells you why.',
        'Checkboxes are easier to click and easier to read. Ticked rows are tinted, and "select all" shows a dash when only some rows are ticked.',
        'Master resume: a calmer layout with a short summary, your roles and skills to add as simple choices, and a preview that looks like a resume.',
        'Search profiles are now a short list of people with a Switch button each. Uploading someone else\'s resume shows one line and one clear next step, with the details tucked away.',
        'Job details: one clean panel instead of boxes inside boxes, with nothing shown twice.',
        'Menus, dialogs, buttons and form fields now share one consistent style, with a soft frosted look that switches to solid if you prefer reduced transparency.',
        'The Find jobs button is now a single glass control with a search icon, in the style of Apple\'s Liquid Glass, instead of two bright blue blocks. The glass catches the light where your pointer is and turns solid if you prefer reduced transparency.',
        'Search recognises more job titles, such as Pharmacovigilance Scientist, Cybersecurity Analyst, Java Developer and Medical Science Liaison.',
        'Search now follows your profile: a nurse looks at healthcare jobs and a security analyst at IT jobs, instead of the same tech categories for everyone.',
        'Wording that only suited software roles is now general. "Stack" is now "Skills", and the GitHub field says it is optional.',
      ],
      fixed: [
        'The tick mark in checkboxes sometimes drew as a broken symbol.',
        'The highlight on the job you have open was not showing on the table.',
        'The status row printed the number of empty profile fields twice ("1 1 empty field").',
        'Date lines in the resume preview, such as "Aug 2018 - Present", were shown as section headings.',
        'One job site was only searched in categories that return nothing, so some searches quietly found less than they should.',
        'Resumes that put a job title and its dates on the same line now read correctly, so a profile made from them can search.',
        'Creating a profile from a resume no longer leaves empty copies behind when it cannot search, and unused profiles can now be deleted.',
        'Buttons in notifications, such as Undo and Switch back, now work while a window is open.',
        'Switching people no longer re-scores the other person\'s jobs, so their scores, shortlists and applications stay exactly as they left them.',
        'Uploading someone else\'s resume as your master resume now asks first, and offers to add them as a new profile instead.',
        'Adding a profile for someone who already has one (for example "Jordan Rivera" and "Jordan A Rivera") now offers their existing profile instead of creating a second one.',
      ],
    },
  },
]);
