#import <React/RCTTextInputComponentView.h>

// React Native 0.83 does not reset secureTextEntry in prepareForRecycle. A
// password field can therefore reappear as a catalog, onboarding, or profile
// field with secure accessibility semantics. Keep TextInput component views
// out of Fabric's recycle pool until the upstream reset covers this trait.
@implementation RCTTextInputComponentView (InternNotifsRecyclingFix)

+ (BOOL)shouldBeRecycled
{
  return NO;
}

@end
