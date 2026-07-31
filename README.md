# stickyprinter
Remote Meeting Participants can create sticky-notes on the web and the moderator on site can instantly print them.

## Description

The context is as follows: sometimes workshops happen to be hybrid although they were planned to be onsite. While the majority of participants usually is gathered onsite in a meeting room, a minority (one or a few participants) join via online conferencing means. Workshops often require the participants to write on sticky notes or pin cards to flipcharts or boards - the remote participants are either excluded from those activities or require an onsite person to write those cards for them, mailing, texting the content to this person.

The project provides a web-based interface, that allows all remote participants to join a workshop using a workshop code, to create notes save and modify those notes online and submit them to the workshop. The workshop moderator is able to see the notes and to print them on a C17 mini printer ( The protocol was reverse engineered and is available via https://github.com/Dejniel/TiMini-Print as TiMiniPrint repository). The moderator should be able to set an "autoprint" option whereby submitted stickies are automatically printed. If this option is not set, a sticky will be shown to the moderator who then can initiate it to be printed, postpone it or reject it back to the author for rework.

### The moderator should use a desktop app for windows as well as a web frontend. The moderator has the following possibilities:

login as moderator
create a workshop, generating a short unique workshop id (e. g. WS-ABCD-1234)
be notified about a submitted sticky with name of participant, counter of participant sticky and first few words on sticky
set stickies to be autoprinted immediatly
view the sticky with the option, print, postpone (return to workshop overview page without printing), reject/revert to participant for rework.

### The participant should have the possibility only via web/browser:

Join Workshop with workshop code
create new sticky
use basic drawing functions & Text
submit sticky to moderator, save sticky (and return to sticky overview), delete sticky
