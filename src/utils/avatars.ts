export const AVATAR_OPTIONS = [
  '🦁', '🐯', '🦊', '🐺', '🐙', '🦈', '🤖', '🦅',
  '🐉', '🦋', '🐝', '🦜', '🦩', '🐧', '👻', '🦖'
];

export function getRandomAvatar(): string {
  return AVATAR_OPTIONS[Math.floor(Math.random() * AVATAR_OPTIONS.length)];
}

export function getAvailableAvatars(usedAvatars: string[]): string[] {
  return AVATAR_OPTIONS.filter(avatar => !usedAvatars.includes(avatar));
}

export function getRandomAvailableAvatar(usedAvatars: string[]): string {
  const available = getAvailableAvatars(usedAvatars);
  if (available.length === 0) {
    // If all avatars are taken, return a random one anyway
    return getRandomAvatar();
  }
  return available[Math.floor(Math.random() * available.length)];
}

export function generateRandomName(): string {
  const adjectives = [
    'Happy', 'Clever', 'Swift', 'Bright', 'Cool', 'Wise', 'Bold', 'Kind',
    'Quick', 'Smart', 'Brave', 'Calm', 'Neat', 'Wild', 'Free', 'Strong'
  ];
  
  const nouns = [
    'Lion', 'Tiger', 'Fox', 'Wolf', 'Eagle', 'Bear', 'Shark', 'Robot',
    'Dragon', 'Butterfly', 'Bee', 'Parrot', 'Flamingo', 'Penguin', 'Ghost', 'Dino'
  ];
  
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  
  return `${adjective} ${noun}`;
}