# Dev Chit Chat

In 2009, at the Velocity conference, a couple of guys who worked at Flickr presented how development and operations fits toghether and gets along ... at Flickr.

The premise is kinda of dumb. Like, why was there even a Devs vs Ops mentality? Regardless, it was real. We were all working on systems and under pressure to build stuff that, quite frankly, was hard.

Anyways, that was the inspiration. Since then, I've championed just collaborating with each other as we build things together.

Along with this, Agile had already been getting traction in corporate America. Scrum was being used to run teams. And Daily Standups were becoing the norm.

In 2013 Github released Hubot as open source, it's home grown chat bot.

I was at GameStop at this time, managing my first team. I saw first hand what a DevOps culture felt like. We deployed the system every week. It was amazing.

Dev Chit Chat came out of that experience and time. Developers meeting daily chit chatting about what they were going to do today, what they learned, etc.

# A Story

I want a chat system that works like Discord, but I don't need the scalability of Discord. I'm just using it for my friends, small teams, not 1000 member community.

Bun is fast and javascript is fine. So let's leverage the accessiblity of both to build a small chat system that does video, audio and screenshare live streaming.

I run bun start the first time and I see a bootstrapping invite code in the console. I double-click on it and copy it to pasteboard. Then I visit https://joey-mac-mini.local:3000 (use your machine name instead of mine in hte URL) and enter it on the signup page to create the first account, it's the admin.

Upon signing in the first time, there's no communication hubs or channels. So we need to create the first ones first so the app can be in a useable state.

The system should just create a default hub and channel. That way, on bootstrap, the system is useable right off the bat. I can start chatting in a channel.