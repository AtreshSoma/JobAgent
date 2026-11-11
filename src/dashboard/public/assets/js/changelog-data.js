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
    date: '2026-11-10',
    summary: 'Share the jobs you are looking at as a neat email.',
    safety: 'Nothing is submitted without your review. That has not changed.',
    groups: {
      new: [
        'Email list, next to the page numbers under the Jobs table, turns the jobs you are viewing into an email draft with a clickable link to each posting. It follows your filters and tab, or uses only the jobs you ticked.',
        'Copy the email and paste it into Gmail, Outlook or Apple Mail with the links intact, open it straight in your email app, or download it as a draft. Nothing is sent from JobAgent.',
        'Also in Activity, under Reports and exports: Email these jobs.',
      ],
      improved: [
        'Security updates for the tools JobAgent is built on, so a fresh install reports no known vulnerabilities.',
      ],
      fixed: [
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
