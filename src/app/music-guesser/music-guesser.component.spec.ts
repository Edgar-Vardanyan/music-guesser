import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MusicGuesserComponent } from './music-guesser.component';

describe('MusicGuesserComponent', () => {
  let component: MusicGuesserComponent;
  let fixture: ComponentFixture<MusicGuesserComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MusicGuesserComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MusicGuesserComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
