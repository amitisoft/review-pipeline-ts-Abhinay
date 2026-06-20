export interface Review {
  id: string;
  stars: number;
  text: string;
}

export const REVIEWS: Review[] = [
  {
    id: "R001",
    stars: 5,
    text: "Absolutely love this espresso machine. Setup took about 10 minutes, the crema is perfect, and it arrived two days early. Worth every penny at $299."
  },
  {
    id: "R002",
    stars: 2,
    text: "The blender worked great for the first week then started making a grinding noise. Customer service took 4 days to respond and still hasn't resolved it. Very disappointed."
  },
  {
    id: "R003",
    stars: 4,
    text: "Nice headphones overall. Sound quality is excellent, battery lasts about 30 hours. Slight issue with the headband being a bit tight at first but it loosened up."
  },
  {
    id: "R004",
    stars: 1,
    text: "DO NOT BUY. This product is dangerous. The charging cable got extremely hot and left a burn mark on my desk. I've filed a report with the manufacturer."
  },
  {
    id: "R005",
    stars: 3,
    text: "It's fine. Does what it says. Nothing special but nothing broken either."
  },
  {
    id: "R006",
    stars: 5,
    text: "I was skeptical at first but the air purifier has genuinely reduced my allergy symptoms. Running it in the bedroom every night for 3 weeks now. Filter replacement looks easy too."
  },
  {
    id: "R007",
    stars: 2,
    text: "Came damaged in shipping. The box was clearly crushed. Waiting on a replacement but the return process has been a nightmare — three different chat agents, each asked me to start over."
  },
  {
    id: "R008",
    stars: 4,
    text: "Great kitchen scale. Accurate to 0.1g which is what I needed for coffee. Only complaint is the display is hard to read in bright light. Fast delivery, good packaging."
  },
  {
    id: "R009",
    stars: 1,
    text: "This is not the product shown in the photo. I ordered the white version and received grey. When I complained I was told 'colors may vary due to screen settings.' That's not acceptable for a $180 purchase."
  },
  {
    id: "R010",
    stars: 3,
    text: "Works as advertised but the instructions are only in German and French. Had to find a YouTube tutorial. Once I figured it out it's actually pretty good."
  }
];